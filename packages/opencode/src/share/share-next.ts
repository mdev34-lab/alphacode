import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { isInternalContextPart, stripInternalContextParts } from "@opencode-ai/schema/v1/session"

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
  /**
   * Live announcement state for `role: "user"` messages, which are the only ones deferred. A
   * missing `info` means the message was already announced, so later updates sync straight
   * through; that marker is what keeps a repeated `MessageV2.Event.Updated` for the same message
   * from re-parking an announced message, which would strand it until its next part.
   */
  pending: Map<string, Deferred>
}

type Deferred = { sessionID: SessionID; info?: SDK.Message }

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      // Keyed per model, not by the record type alone. `queue` is a dedupe map, so a constant
      // key made two model records in the same flush window collapse into the last one written,
      // silently dropping the other model from that batch.
      return `model/${item.data.map((model) => model.id).join(",")}`
  }
}

/**
 * Upper bound on the live announcement map. A user message is deferred only between its
 * `MessageV2.Event.Updated` and the first part of that same turn, so the number of live
 * deferrals is the number of in-flight prompts, not the length of the session. The bound is a
 * backstop against a leak, and `prunePending` on `full()`/`remove()` reclaims the rest.
 */
const maxPending = 64

function prunePending(state: State, sessionID: SessionID) {
  for (const [id, deferred] of state.pending) {
    if (deferred.sessionID === sessionID) state.pending.delete(id)
  }
}

function boundPending(state: State) {
  // `Map` iterates in insertion order and re-setting an existing key keeps its position, so the
  // oldest entry is the one that has waited longest for a part and the least likely to still get
  // one. Evicting it cannot strand a message that is about to be announced.
  while (state.pending.size > maxPending) {
    const oldest = state.pending.keys().next()
    if (oldest.done) return
    state.pending.delete(oldest.value)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    function sync(sessionID: SessionID, data: Data[]) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (!share) return

        const s = yield* InstanceState.get(state)
        const existing = s.queue.get(sessionID)
        if (existing) {
          for (const item of data) {
            existing.set(key(item), item)
          }
          return
        }

        const next = new Map(data.map((item) => [key(item), item]))
        s.queue.set(sessionID, next)
        yield* flush(sessionID).pipe(
          Effect.delay(1000),
          Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID: sessionID, cause: cause })),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = { queue: new Map(), scope: yield* Scope.make(), shared: new Map(), pending: new Map() }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
                cache.pending.clear()
              }),
            ),
          ),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          events.listen((event) => {
            if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
            return fn(event.data as EventV2.Data<D>).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
              ),
            )
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id, [{ type: "session", data: structuredClone(info) as SDK.Session }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            const deferred = cache.pending.get(info.id)

            // Assistant messages are never deferred. They always carry real content, and their
            // terminal update (cost, tokens, finish reason, completion time, error) is the last
            // event of the message with no part after it, so deferring it would strand that final
            // state in a public transcript forever.
            if (info.role !== "user")
              return yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])

            // A message seen before: refresh it while still deferred, and sync it once announced.
            if (deferred) {
              if (!deferred.info)
                yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])
              else deferred.info = structuredClone(info) as SDK.Message
              return
            }

            // First sighting. `Data` is upsert-only, so nothing synced here can be un-sent, and
            // auto-compaction creates a `role: "user"` message whose only part is the internal
            // continue marker. Announcing that message and then dropping its part in the filter
            // below leaves a permanent empty bubble. Park it instead; the first part that
            // survives filtering announces it together with itself.
            if (!(yield* getCached(info.sessionID))) return
            cache.pending.set(info.id, { sessionID: info.sessionID, info: structuredClone(info) as SDK.Message })
            boundPending(cache)
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (data) =>
          Effect.gen(function* () {
            // Internal context markers are engine bookkeeping, not conversation. A share is a public
            // URL, so the live stream must be filtered too, not just the cold `full()` sync. This
            // is deliberately scoped to compaction bookkeeping: injected reminders and other
            // context that the engine adds to a message the user actually wrote are part of the
            // transcript a reader expects, and filtering them is out of scope here.
            if (isInternalContextPart(data.part)) return
            const deferred = cache.pending.get(data.part.messageID)
            if (!deferred?.info)
              return yield* sync(data.part.sessionID, [{ type: "part", data: structuredClone(data.part) as SDK.Part }])
            const message = deferred.info
            deferred.info = undefined
            yield* sync(data.part.sessionID, [
              { type: "message", data: message },
              { type: "part", data: structuredClone(data.part) as SDK.Part },
            ])
            if (message.role !== "user") return
            const model = yield* provider.getModel(
              ProviderV2.ID.make(message.model.providerID),
              ModelV2.ID.make(message.model.modelID),
            )
            yield* sync(data.part.sessionID, [{ type: "model", data: [model] }])
          }),
        )
        yield* watch(Session.Event.Diff, (data) =>
          sync(data.sessionID, [{ type: "session_diff", data: structuredClone(data.diff) as SDK.SnapshotFileDiff[] }]),
        )
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      const queued = s.queue.get(sessionID)
      if (!queued) return

      s.queue.delete(sessionID)

      const share = yield* getCached(sessionID)
      if (!share) return

      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret, data: Array.from(queued.values()) }),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        yield* Effect.logWarning("failed to sync share", {
          sessionID: sessionID,
          shareID: share.id,
          status: res.status,
        })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      // Prune before reading, not after. Reading first left the window where a park lands
      // between the read and the prune and is dropped by a snapshot that already contains the
      // message; pruning first makes the snapshot below authoritative for everything that
      // existed at read time, and anything parked after it belongs to a newer message whose own
      // first part still announces it.
      prunePending(yield* InstanceState.get(state), sessionID)
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      const messages = yield* session.messages({ sessionID })
      const models = yield* Effect.forEach(
        Array.from(
          new Map(
            messages
              .filter((msg) => msg.info.role === "user")
              .map((msg) => (msg.info as SDK.UserMessage).model)
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).values(),
        ),
        (item) => provider.getModel(ProviderV2.ID.make(item.providerID), ModelV2.ID.make(item.modelID)),
        { concurrency: 8 },
      )

      const shareable = messages.map((item) => stripInternalContextParts(item)).filter((item) => item !== undefined)

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...shareable.map((item) => ({ type: "message" as const, data: item.info })),
        ...shareable.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
      prunePending(s, sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Account.node, EventV2Bridge.node, Config.node, Database.node, httpClient, Provider.node, Session.node],
})

export * as ShareNext from "./share-next"
