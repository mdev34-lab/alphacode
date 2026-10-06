import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { applyPatch } from "diff"
import { exists, readText } from "@/util/filesystem"
import type { ACPSession } from "./session"
import { pendingToolCall, toLocations, type ToolInput } from "./tool"
import { Effect } from "effect"
import { signal } from "@/util/signal"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type RepliedEvent = Extract<Event, { type: "permission.replied" }>
type Reply = "once" | "always" | "reject"
type Connection = Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile" | "extNotification">>

// Where one prompt is on the ACP side: `queued` while it waits behind the session's other
// prompts, `waiting` while the editor has it open, `settled` once nothing more is expected
// from the editor — either the server resolved the request itself or the editor's answer is
// already on its way back. `requestID` is the JSON-RPC id of the outgoing
// `session/request_permission`, which is what cancelling that dialog is aimed by.
type Prompt =
  | { readonly state: "queued" }
  | { readonly state: "waiting"; readonly requestID: number | undefined; readonly release: () => void }
  | { readonly state: "settled" }

const permissionOptions: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

export class Handler {
  private readonly queues = new Map<string, Promise<void>>()
  // A prompt the server settles by itself — a countdown expiring, another client answering,
  // a reject cascading over the session — has to be let go of here, because prompts are
  // serialized per session and one unanswered question would block every later prompt for
  // that session. Releasing the wait frees OpenCode; `$/cancel_request` then asks the editor
  // to close a dialog it already has open. Clients that do not implement that unstable
  // notification ignore it, and the failed tool call part following a timeout is what tells
  // them the operation was denied.
  private readonly prompts = new Map<string, Prompt>()

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  handle(event: PermissionEvent) {
    const permission = event.properties
    this.prompts.set(permission.id, { state: "queued" })
    const previous = this.queues.get(permission.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(permission.sessionID) === next) {
          this.queues.delete(permission.sessionID)
        }
      })
    this.queues.set(permission.sessionID, next)
  }

  replied(event: RepliedEvent) {
    const requestID = event.properties.requestID
    const prompt = this.prompts.get(requestID)
    if (!prompt) return
    if (prompt.state === "waiting") {
      prompt.release()
      this.cancel(prompt.requestID)
    }
    // Kept as `settled` rather than dropped: the prompt may still be queued behind another
    // one for the session, in which case `process` has to skip it instead of asking the
    // editor about a request the server already resolved.
    this.prompts.set(requestID, { state: "settled" })
  }

  private async process(event: PermissionEvent) {
    const permission = event.properties
    try {
      // The server can settle the request during any of the awaits below, so the state is
      // re-read after each one: asking the editor about a request that is already gone
      // leaves a dialog nobody can answer and a session queue waiting behind it.
      if (this.settled(permission.id)) return

      const session = await Effect.runPromise(this.input.session.tryGet(permission.sessionID))
      if (!session || this.settled(permission.id)) return

      if (!this.input.connection.requestPermission) {
        await this.reply(permission.id, "reject", session.cwd)
        return
      }

      // Read from disk, so it is awaited before the request is built rather than inside it.
      const toolCall = await permissionToolCall({
        toolCallId: permission.tool?.callID ?? permission.id,
        toolName: permission.permission,
        input: permission.metadata,
      })

      const settled = signal()
      // Last gate before the editor is asked, and the point where the JSON-RPC id is read:
      // the SDK allocates it during the call below, so nothing else can run in between.
      const requestID = nextRequestID(this.input.connection)
      if (!this.waiting(permission.id, requestID, () => settled.trigger())) return

      const result = await Promise.race([
        this.input.connection
          .requestPermission({
            sessionId: permission.sessionID,
            toolCall,
            options: permissionOptions,
          })
          .catch(async () => {
            this.answered(permission.id)
            await this.reply(permission.id, "reject", session.cwd)
            return undefined
          }),
        settled.wait().then(() => undefined),
      ])

      // Either the editor never answered or the server settled the request while it was
      // open; both leave nothing for this handler to reply to.
      if (!result) return

      const reply = selectedReply(result)
      this.answered(permission.id)
      if (reply !== "once" && reply !== "always") {
        await this.reply(permission.id, "reject", session.cwd)
        return
      }

      if (permission.permission === "edit") {
        await this.writeProposedEdit(session.id, permission.metadata).catch(() => {})
      }

      await this.reply(permission.id, reply, session.cwd)
    } finally {
      // A throw anywhere above — the filesystem work in `permissionToolCall` is the likely
      // one — must not leave the prompt tracked, or the entry outlives the request it
      // belongs to and a later `permission.replied` would be aimed at the wrong state.
      this.prompts.delete(permission.id)
    }
  }

  // Moves a prompt to `waiting` unless the server settled it first, in which case there is
  // nothing left to ask the editor about.
  private waiting(id: string, requestID: number | undefined, release: () => void) {
    if (this.settled(id)) return false
    this.prompts.set(id, { state: "waiting", requestID, release })
    return true
  }

  private settled(id: string) {
    return this.prompts.get(id)?.state === "settled"
  }

  // Marks the prompt done with the editor before its answer is posted, not after: posting is
  // what makes the server publish `permission.replied`, and that event arriving while the
  // prompt still looks like it is waiting on the editor would cancel a dialog the editor has
  // already completed.
  private answered(id: string) {
    if (this.prompts.get(id)?.state === "waiting") this.prompts.set(id, { state: "settled" })
  }

  // Best-effort by nature: only the editor can close its own dialog, and a client that does
  // not implement the notification simply ignores it. `$/cancel_request` is UNSTABLE in the
  // schema of the SDK pinned here (0.21.0), which no client of that version dispatches, and
  // the schema is explicit that a `$/` notification is free to be ignored.
  private cancel(requestID: number | undefined) {
    if (requestID === undefined) return
    void this.input.connection.extNotification?.("$/cancel_request", { requestId: requestID }).catch(() => {})
  }

  private async reply(requestID: string, reply: Reply, directory: string) {
    await this.input.sdk.permission.reply({
      requestID,
      reply,
      directory,
    })
  }

  private async writeProposedEdit(sessionId: string, metadata: ToolInput) {
    const filepath = stringValue(metadata.filepath)
    const diff = stringValue(metadata.diff)
    if (!filepath || !diff || !this.input.connection.writeTextFile) return

    const content = (await exists(filepath)) ? await readText(filepath) : ""
    const next = applyPatch(content, diff)
    if (next === false) {
      return
    }

    void this.input.connection.writeTextFile({
      sessionId,
      path: filepath,
      content: next,
    })
  }
}

// `$/cancel_request` is aimed by the JSON-RPC id of the request to cancel, and the pinned
// SDK (0.21.0) never hands that id back: `requestPermission` resolves to the response only
// and exposes no cancel API of its own. The id is the connection's next request id at the
// moment of the call, so reading it immediately before is exact — nothing else runs in
// between. Both fields are private to the SDK, which is why this stays defensive: a version
// that hides them yields `undefined`, no cancel is sent, and the dialog is left open, which
// is exactly what happens today.
function nextRequestID(connection: Connection) {
  const inner: unknown = Reflect.get(connection, "connection")
  const id: unknown = typeof inner === "object" && inner !== null ? Reflect.get(inner, "nextRequestId") : undefined
  return typeof id === "number" ? id : undefined
}

async function permissionToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
}): Promise<ToolCallUpdate> {
  const toolCall = pendingToolCall({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    state: {
      input: input.input,
      title: permissionTitle(input.toolName, input.input),
    },
  })
  const content = await permissionContent(input.toolName, input.input)
  return {
    ...toolCall,
    locations: permissionLocations(input.toolName, input.input),
    ...(content.length ? { content } : {}),
  }
}

function permissionTitle(toolName: string, input: ToolInput) {
  const tool = toolName.toLocaleLowerCase()
  switch (tool) {
    case "external_directory":
      return stringValue(input.description) ?? stringValue(input.command) ?? stringValue(input.parentDir)

    case "webfetch":
      return stringValue(input.url)

    case "websearch":
      return stringValue(input.query)

    case "grep":
    case "glob":
      return stringValue(input.pattern)

    case "read":
    case "edit":
    case "write":
      return editTitle(input)

    default:
      return undefined
  }
}

function editTitle(input: ToolInput) {
  const files = fileMetadata(input)
  if (files.length === 1) return files[0]?.relativePath ?? files[0]?.filePath
  if (files.length > 1) return `${files.length} files`
  return stringValue(input.filePath) ?? stringValue(input.filepath) ?? stringValue(input.path)
}

function permissionLocations(toolName: string, input: ToolInput): ToolCallLocation[] {
  const files = fileMetadata(input)
  if (files.length) {
    return Array.from(
      new Set(files.flatMap((file) => [file.filePath, file.movePath].filter((path): path is string => !!path))),
      (path) => ({ path }),
    )
  }
  return toLocations(toolName, input)
}

async function permissionContent(toolName: string, input: ToolInput): Promise<ToolCallContent[]> {
  if (toolName.toLocaleLowerCase() !== "edit") return []

  const files = fileMetadata(input)
  if (files.length) return diffContentForFiles(files)

  const filepath = stringValue(input.filepath) ?? stringValue(input.filePath)
  const diff = stringValue(input.diff)
  if (!filepath || !diff) return []
  const content = await diffContentForPatch(filepath, diff)
  return content ? [content] : []
}

async function diffContentForFiles(files: PermissionFileMetadata[]) {
  const content = await Promise.all(
    files.map(async (file) => {
      if (!file.patch) return []
      const content = await diffContentForPatch(file.filePath, file.patch, file.movePath)
      return content ? [content] : []
    }),
  )
  return content.flat()
}

async function diffContentForPatch(filepath: string, diff: string, displayPath = filepath) {
  const content = (await exists(filepath)) ? await readText(filepath) : ""
  const next = applyPatch(content, diff)
  if (next === false) return undefined
  return {
    type: "diff" as const,
    path: displayPath,
    oldText: content,
    newText: next,
  }
}

function selectedReply(result: RequestPermissionResponse): Reply {
  if (result.outcome.outcome !== "selected") return "reject"
  if (result.outcome.optionId === "once" || result.outcome.optionId === "always") return result.outcome.optionId
  return "reject"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

type PermissionFileMetadata = {
  readonly filePath: string
  readonly relativePath?: string
  readonly movePath?: string
  readonly patch?: string
}

function fileMetadata(input: ToolInput): PermissionFileMetadata[] {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((file): PermissionFileMetadata[] => {
    if (!file || typeof file !== "object") return []
    const info = file as Record<string, unknown>
    const filePath = stringValue(info.filePath)
    if (!filePath) return []
    return [
      {
        filePath,
        relativePath: stringValue(info.relativePath),
        movePath: stringValue(info.movePath),
        patch: stringValue(info.patch),
      },
    ]
  })
}

export * as ACPPermission from "./permission"
