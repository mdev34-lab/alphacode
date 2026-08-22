/**
 * Materializes conversation attachments (pasted media, mentioned files, remote
 * URLs) into a managed directory and records the local `path`/`size` on the
 * durable `Prompt.FileAttachment`. This turns the previously opaque attachment
 * URI into bytes the agent can read, reference, and later persist as a project
 * file via the `attachment` tool. Failures degrade gracefully: an attachment
 * that cannot be fetched (or exceeds the size budget) is admitted unchanged and
 * flagged unavailable, preserving durable history.
 */
import path from "path"
import { fileURLToPath } from "url"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { LocationMutation } from "./location-mutation"
import { PermissionV2 } from "./permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Identifier } from "./util/identifier"
import { collectBoundedResponseBody } from "./tool/http-body"
import { SessionSchema } from "./session/schema"
import { SessionProjector } from "./session/projector"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"

export const MANAGED_DIRECTORY = "attachments"
export const MAX_BYTES = 50 * 1024 * 1024
export const RETENTION = Duration.days(7)

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/aiff": "aiff",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
}

const parseDataUri = (uri: string): { mime: string; base64: boolean; payload: string } | null => {
  const match = uri.match(/^data:([^;,]+)(;[^,]*)?,([\s\S]*)$/)
  if (!match) return null
  return { mime: match[1].toLowerCase(), base64: match[2]?.includes("base64") ?? false, payload: match[3] }
}

const finalMime = (uri: string, declared: string, name?: string) => {
  const parsed = parseDataUri(uri)
  if (parsed) return parsed.mime
  if (declared && declared !== "application/octet-stream") return declared.toLowerCase()
  const target = uri.startsWith("file://") ? fileURLToPath(uri) : (name ?? uri)
  return FSUtil.mimeType(target)
}

const extensionFor = (mime: string) => EXTENSIONS[mime] ?? "bin"

const sourceOf = (uri: string, kind: string | undefined) => {
  if (kind) return kind
  if (uri.startsWith("data:")) return "paste"
  if (uri.startsWith("http://") || uri.startsWith("https://")) return "url"
  if (uri.startsWith("file://")) return "file"
  return "unknown"
}

export interface MaterializeInput {
  readonly sessionID: SessionSchema.ID
  readonly agent?: SessionMessage.Agent["id"]
  readonly attachment: PromptInput.FileAttachment
}

export interface CopyInput {
  readonly sessionID: SessionSchema.ID
  readonly agent?: SessionMessage.Agent["id"]
  readonly id: string
  readonly target: string
}

export interface InventoryRow {
  readonly id: string
  readonly name?: string
  readonly mime: string
  readonly source: string
  readonly size?: number
  readonly unavailable?: boolean
}

export interface Interface {
  readonly materialize: (input: MaterializeInput) => Effect.Effect<Prompt.FileAttachment>
  readonly inventory: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<InventoryRow>>
  readonly copyTo: (input: CopyInput) => Effect.Effect<{ readonly resource: string }, PermissionV2.Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AttachmentStore") {}

const readBytes = (
  fs: FSUtil.Interface,
  location: LocationMutation.Interface,
  permission: PermissionV2.Interface,
  sessionID: SessionSchema.ID,
  agent: SessionMessage.Agent["id"] | undefined,
  uri: string,
) =>
  Effect.gen(function* () {
    const target = yield* location.resolve({ path: fileURLToPath(uri), kind: "file" })
    const external = target.externalDirectory
    const source = { type: "tool" as const, messageID: SessionMessage.ID.create(), callID: "attachment-materialize" }
    if (external)
      yield* permission.assert({
        ...LocationMutation.externalDirectoryPermission(external),
        sessionID,
        agent,
        source,
      })
    yield* permission.assert({
      action: "read",
      resources: [target.resource],
      sessionID,
      agent,
      source,
    })
    const info = yield* fs.stat(target.canonical).pipe(Effect.catch(() => Effect.void))
    const size = info && "size" in info ? (info.size as number) : Number.NaN
    if (Number.isFinite(size) && size > MAX_BYTES)
      return yield* Effect.fail(new Error(`Attachment exceeds the ${MAX_BYTES} byte limit`))
    const bytes = yield* fs.readFile(target.canonical)
    return bytes as Uint8Array
  })

const fetchBytes = (http: HttpClient.HttpClient, permission: PermissionV2.Interface, sessionID: SessionSchema.ID, agent: SessionMessage.Agent["id"] | undefined, uri: string) =>
  Effect.gen(function* () {
    yield* permission.assert({
      action: "web",
      resources: [uri],
      sessionID,
      agent,
      source: { type: "tool", messageID: SessionMessage.ID.create(), callID: "attachment-materialize" },
    })
    const response = yield* http
      .execute(HttpClientRequest.get(uri))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
    const bytes = yield* collectBoundedResponseBody(response, MAX_BYTES, () =>
      Effect.fail(new Error(`Attachment exceeds the ${MAX_BYTES} byte limit`)),
    )
    return bytes as Uint8Array
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const location = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)

    const write = Effect.fn("AttachmentStore.write")(function* (sessionID: string, id: string, mime: string, bytes: Uint8Array) {
      const file = path.join(directory, sessionID, `${id}.${extensionFor(mime)}`)
      yield* fs.ensureDir(path.dirname(file)).pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs.writeFile(file, bytes).pipe(Effect.mapError((cause) => new Error(String(cause))))
      return file
    })

    const materialize = Effect.fn("AttachmentStore.materialize")(function* (input: MaterializeInput) {
      const { attachment } = input
      if (attachment.path !== undefined) return Prompt.FileAttachment.create(attachment as Prompt.FileAttachment)
      return yield* Effect.gen(function* () {
        const id = attachment.id ?? Identifier.ascending("att")
        const mime = finalMime(attachment.uri, attachment.mime, attachment.name)
        let bytes: Uint8Array | undefined
        if (attachment.uri.startsWith("data:")) {
          const parsed = parseDataUri(attachment.uri)
          bytes = parsed ? (parsed.base64 ? Buffer.from(parsed.payload, "base64") : Buffer.from(decodeURIComponent(parsed.payload), "utf8")) : Buffer.from([])
        } else if (attachment.uri.startsWith("http://") || attachment.uri.startsWith("https://")) {
          bytes = yield* fetchBytes(http, permission, input.sessionID, input.agent, attachment.uri)
        } else if (attachment.uri.startsWith("file://")) {
          bytes = yield* readBytes(fs, location, permission, input.sessionID, input.agent, attachment.uri)
        } else {
          return Prompt.FileAttachment.create({ ...attachment, id } as Prompt.FileAttachment)
        }
        if (bytes.length > MAX_BYTES) return Prompt.FileAttachment.create({ ...attachment, id } as Prompt.FileAttachment)
        const file = yield* write(input.sessionID, id, mime, bytes)
        return Prompt.FileAttachment.create({
          id,
          uri: attachment.uri,
          mime,
          name: attachment.name,
          description: attachment.description,
          source: attachment.source,
          path: file,
          size: bytes.length,
        })
      }).pipe(
        Effect.catch((error) => Effect.log(`attachment materialization failed: ${String(error)}`).pipe(Effect.andThen(() => Effect.succeed(undefined)))),
        Effect.flatMap((result) => result === undefined ? Effect.succeed(Prompt.FileAttachment.create({ ...attachment, id: attachment.id ?? Identifier.ascending("att") } as Prompt.FileAttachment)) : Effect.succeed(result)),
      )
    })

    const inventory = Effect.fn("AttachmentStore.inventory")(function* (sessionID: SessionSchema.ID) {
      const projector = yield* SessionProjector.Service
      const messages = yield* projector.load(sessionID)
      return messages
        .filter((message): message is Extract<typeof message, { type: "user" }> => message.type === "user")
        .flatMap((message) => message.files ?? [])
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== undefined)
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          source: sourceOf(attachment.uri, attachment.source?.type),
          size: attachment.size,
          unavailable: attachment.path === undefined ? true : undefined,
        }))
    })

    const copyTo = Effect.fn("AttachmentStore.copyTo")(function* (input: CopyInput) {
      const target = yield* location.resolve({ path: input.target, kind: "file" })
      const external = target.externalDirectory
      const source = { type: "tool" as const, messageID: SessionMessage.ID.create(), callID: input.id }
      if (external)
        yield* permission.assert({
          ...LocationMutation.externalDirectoryPermission(external),
          sessionID: input.sessionID,
          agent: input.agent,
          source,
        })
      yield* permission.assert({
        action: "edit",
        resources: [target.resource],
        save: ["*"],
        sessionID: input.sessionID,
        agent: input.agent,
        source,
      })
      const entries = yield* fs.readDirectoryEntries(path.join(directory, input.sessionID)).pipe(
        Effect.catch(() => Effect.succeed([])),
      )
      const match = entries.find((entry) => entry.name === `${input.id}${path.extname(entry.name)}`)
      if (!match) return yield* Effect.fail(new Error(`Attachment ${input.id} not found in managed store`))
      const bytes = yield* fs
        .readFile(path.join(directory, input.sessionID, match.name))
        .pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs
        .ensureDir(path.dirname(target.canonical))
        .pipe(Effect.mapError((cause) => new Error(String(cause))))
      yield* fs.writeFile(target.canonical, bytes).pipe(Effect.mapError((cause) => new Error(String(cause))))
      return { resource: target.resource }
    })

    const cleanup = Effect.fn("AttachmentStore.cleanup")(function* () {
      const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (entry.type !== "directory") continue
        const sub = path.join(directory, entry.name)
        const files = yield* fs.readDirectoryEntries(sub).pipe(Effect.catch(() => Effect.succeed([])))
        for (const file of files) {
          const full = path.join(sub, file.name)
          const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.void))
          const modified = info && "mtimeMs" in info ? (info.mtimeMs as number) : 0
          if (modified !== 0 && modified < cutoff)
            yield* fs.remove(full).pipe(Effect.catch(() => Effect.void))
        }
      }
    })

    return Service.of({ materialize, inventory, copyTo, cleanup })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    FSUtil.node,
    Global.node,
    LocationMutation.node,
    PermissionV2.node,
    LayerNodePlatform.httpClient,
    SessionProjector.node,
  ],
})

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "attachment-store-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
