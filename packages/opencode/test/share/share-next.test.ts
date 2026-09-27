import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function requestLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), [replacement])
}

function integrationLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(
    LayerNode.group([
      ShareNext.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
    ]),
    [replacement],
  )
}

// Live user messages make ShareNext resolve the model for the transcript, which a bare test
// provider cannot do. Only `getModel` is exercised here.
function userLayer(client: HttpClient.HttpClient) {
  return LayerNode.compile(
    LayerNode.group([ShareNext.node, EventV2Bridge.node, Session.node, SessionProjector.node, Database.node]),
    [
      [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      [
        Provider.node,
        Layer.mock(Provider.Service, {
          getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) =>
            Effect.succeed({ id: modelID, providerID, name: modelID, capabilities: {}, limit: {} } as never),
        }),
      ],
    ],
  )
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request uses default URL when no enterprise config", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request()

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () => {
        const createRequests: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/api/share")) {
            createRequests.push(req)
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(json(req, { ok: true }))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })

          const result = yield* (yield* ShareNext.Service).create(session.id)

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://legacy-share.example.com/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = yield* share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(createRequests).toHaveLength(1)
          expect(createRequests[0].method).toBe("POST")
          expect(createRequests[0].url).toBe("https://legacy-share.example.com/api/share")
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          if (req.method === "POST") {
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })
          const service = yield* ShareNext.Service

          yield* service.create(session.id)
          yield* service.remove(session.id)

          expect(yield* share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://legacy-share.example.com/api/share"],
            ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() => {
      const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))
      return Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* share(session.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(client)))
    }),
  )

  it.live("ShareNext coalesces rapid diff events into one delayed sync with latest data", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "a.ts",
                patch:
                  "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          })
          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "b.ts",
                patch:
                  "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                additions: 2,
                deletions: 0,
                status: "modified",
              },
            ],
          })
          yield* pollWithTimeout(
            Effect.sync(() => (seen.length === 1 ? true : undefined)),
            "timed out waiting for share sync",
            "5 seconds",
          )

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as {
            secret: string
            data: Array<{
              type: string
              data: Array<{
                file: string
                patch: string
                additions: number
                deletions: number
                status?: string
              }>
            }>
          }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0].type).toBe("session_diff")
          expect(body.data[0].data).toEqual([
            {
              file: "b.ts",
              patch:
                "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
              additions: 2,
              deletions: 0,
              status: "modified",
            },
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})

// A share URL is public, so internal compaction / context-marker parts must not reach it on either
// the cold `full()` path or the live `PartUpdated` stream. Everything else, including `synthetic`
// content that is legitimate conversation, must survive.
describe("ShareNext internal context markers", () => {
  const CONTEXT_MARKER = "compacted context summary"
  const MCP_TEXT = "server://docs/readme.md contents"
  const TASK_TEXT = "Background task build finished: 3 files changed"

  const collect = () => {
    const bodies: Array<{ data: Array<{ type: string; data: unknown }> }> = []
    const client = HttpClient.make((req) => {
      if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
        bodies.push(JSON.parse(new TextDecoder().decode(req.body.body)))
      }
      if (req.method === "POST" && req.url.endsWith("/share")) {
        return Effect.succeed(
          json(req, { id: "shr_ctx", url: "https://legacy-share.example.com/share/ctx", secret: "sec_ctx" }),
        )
      }
      return Effect.succeed(json(req, { ok: true }))
    })
    return { bodies, client }
  }

  const register = (sessionID: SessionID) =>
    Effect.gen(function* () {
      yield* ShareNext.Service.use((svc) => svc.init())
      yield* Effect.sleep(50)
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionShareTable)
        .values({
          session_id: sessionID,
          id: "shr_ctx",
          url: "https://legacy-share.example.com/share/ctx",
          secret: "sec_ctx",
        })
        .run()
        .pipe(Effect.orDie)
    })

  // Assistant messages keep `full()` off the `provider.getModel` path, so these tests exercise
  // part filtering rather than model resolution. `parentID` is only a foreign key in the payload,
  // so a synthetic id keeps a real user message (and its model lookup) out of the fixture.
  const seedMessage = (sessionID: SessionID, parts: Array<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        parentID: MessageID.ascending(),
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "work",
        agent: "work",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      for (const part of parts) {
        yield* session.updatePart({ ...part, sessionID, messageID: message.id } as never)
      }
      return message
    })

  const textPart = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "text",
    text,
    time: { start: Date.now(), end: Date.now() },
    ...extra,
  })

  const syncedParts = (bodies: Array<{ data: Array<{ type: string; data: unknown }> }>) =>
    bodies
      .flatMap((body) => body.data)
      .filter((item) => item.type === "part")
      .map((item) => item.data as { id: string; type: string; text?: string })

  it.live("full() strips the compaction marker but keeps normal and legitimate synthetic parts", () =>
    provideTmpdirInstance(
      () => {
        const { bodies, client } = collect()
        return Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "markers" })
          yield* seedMessage(info.id, [
            textPart(PartID.ascending(), "here is the answer"),
            textPart(PartID.ascending(), CONTEXT_MARKER, {
              synthetic: true,
              metadata: { compaction_continue: true },
            }),
            textPart(PartID.ascending(), MCP_TEXT, { synthetic: true }),
            textPart(PartID.ascending(), TASK_TEXT, { synthetic: true }),
            { id: PartID.ascending(), type: "compaction", auto: true },
          ])

          yield* (yield* ShareNext.Service).create(info.id)
          yield* pollWithTimeout(
            Effect.sync(() => (bodies.length > 0 ? true : undefined)),
            "timed out waiting for share full sync",
            "5 seconds",
          )

          const parts = syncedParts(bodies)
          expect(parts.map((part) => part.text).filter(Boolean)).toEqual(["here is the answer", MCP_TEXT, TASK_TEXT])
          expect(parts.some((part) => part.text === CONTEXT_MARKER)).toBe(false)
          expect(parts.some((part) => part.type === "compaction")).toBe(false)
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("live PartUpdated drops the compaction marker and forwards everything else", () =>
    provideTmpdirInstance(
      () => {
        const { bodies, client } = collect()
        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const session = yield* Session.Service
          const info = yield* session.create({ title: "live" })
          const message = yield* seedMessage(info.id, [textPart(PartID.ascending(), "here is the answer")])

          yield* register(info.id)
          yield* Effect.sleep(50)

          for (const part of [
            textPart(PartID.ascending(), "here is the answer"),
            textPart(PartID.ascending(), CONTEXT_MARKER, {
              synthetic: true,
              metadata: { compaction_continue: true },
            }),
            textPart(PartID.ascending(), MCP_TEXT, { synthetic: true }),
            { id: PartID.ascending(), type: "compaction", auto: true, time: { start: Date.now(), end: Date.now() } },
          ]) {
            yield* events.publish(MessageV2.Event.PartUpdated, {
              sessionID: info.id,
              time: Date.now(),
              part: { ...part, sessionID: info.id, messageID: message.id } as never,
            })
          }

          yield* pollWithTimeout(
            Effect.sync(() => (bodies.length > 0 ? true : undefined)),
            "timed out waiting for share live sync",
            "5 seconds",
          )
          yield* Effect.sleep(50)

          const parts = syncedParts(bodies)
          expect(parts.map((part) => part.text).filter(Boolean)).toEqual(["here is the answer", MCP_TEXT])
          expect(parts.some((part) => part.text === CONTEXT_MARKER)).toBe(false)
          expect(parts.some((part) => part.type === "compaction")).toBe(false)
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("prunes a message stripped down to nothing, but keeps one that still holds a tool result", () =>
    provideTmpdirInstance(
      () => {
        const { bodies, client } = collect()
        return Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "pruning" })

          const markerOnly = yield* seedMessage(info.id, [{ id: PartID.ascending(), type: "compaction", auto: true }])
          const toolCarrier = yield* seedMessage(info.id, [
            { id: PartID.ascending(), type: "compaction", auto: true },
            {
              id: PartID.ascending(),
              type: "tool",
              tool: "read",
              callID: "call_1",
              state: {
                status: "completed",
                input: { path: "a.ts" },
                output: "file body",
                title: "read a.ts",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ])

          yield* (yield* ShareNext.Service).create(info.id)
          yield* pollWithTimeout(
            Effect.sync(() => (bodies.length > 0 ? true : undefined)),
            "timed out waiting for share full sync",
            "5 seconds",
          )

          const messageIDs = bodies
            .flatMap((body) => body.data)
            .filter((item) => item.type === "message")
            .map((item) => (item.data as { id: string }).id)

          expect(messageIDs).toContain(toolCarrier.id)
          expect(messageIDs).not.toContain(markerOnly.id)
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})

// The share protocol is upsert-only: nothing synced for a message can be un-sent. So the live
// `MessageV2.Event.Updated` watcher must not announce a message that only ever carries internal
// context, or the public transcript keeps a permanent empty bubble.
describe("ShareNext live user messages", () => {
  const ENTERPRISE = { config: { enterprise: { url: "https://legacy-share.example.com" } } }

  const collect = () => {
    const bodies: Array<{ data: Array<{ type: string; data: unknown }> }> = []
    const client = HttpClient.make((req) => {
      if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
        bodies.push(JSON.parse(new TextDecoder().decode(req.body.body)))
      }
      return Effect.succeed(json(req, { ok: true }))
    })
    return { bodies, client }
  }

  const markerText = (id: string) => ({
    id,
    type: "text",
    text: "Continue if you have next steps",
    synthetic: true,
    metadata: { compaction_continue: true },
    time: { start: Date.now(), end: Date.now() },
  })

  const userText = (id: string, text: string) => ({
    id,
    type: "text",
    text,
    time: { start: Date.now(), end: Date.now() },
  })

  const userInfo = (sessionID: SessionID, id: string) => ({
    id,
    role: "user",
    sessionID,
    agent: "work",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })

  const assistantInfo = (sessionID: SessionID, id: string) => ({
    id,
    role: "assistant",
    sessionID,
    parentID: MessageID.ascending(),
    agent: "work",
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "work",
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })

  const live = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      return (info: { id: string }, parts: Array<Record<string, unknown>>) =>
        Effect.gen(function* () {
          yield* events.publish(MessageV2.Event.Updated, { sessionID, info: info as never })
          for (const part of parts) {
            yield* events.publish(MessageV2.Event.PartUpdated, {
              sessionID,
              time: Date.now(),
              part: { ...part, sessionID, messageID: info.id } as never,
            })
          }
        })
    })

  const register = (sessionID: SessionID) =>
    Effect.gen(function* () {
      yield* ShareNext.Service.use((svc) => svc.init())
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionShareTable)
        .values({
          session_id: sessionID,
          id: "shr_live",
          url: "https://legacy-share.example.com/share/live",
          secret: "sec_live",
        })
        .run()
        .pipe(Effect.orDie)
    })

  const synced = (bodies: Array<{ data: Array<{ type: string; data: unknown }> }>, type: string) =>
    bodies
      .flatMap((body) => body.data)
      .filter((item) => item.type === type)
      .map((item) => item.data as { id: string; type: string; text?: string; messageID?: string; sessionID?: string })

  it.live("never announces a live user message that only carries the continuation marker", () =>
    provideTmpdirInstance(() => {
      const { bodies, client } = collect()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create({ title: "live marker" })
        yield* register(info.id)
        const publish = yield* live(info.id)

        const markerMessage = MessageID.ascending()
        yield* publish(userInfo(info.id, markerMessage), [markerText(PartID.ascending())])

        // A real message afterwards proves the live pipeline is running, so "absent" below is a
        // filter result and not a dead watcher.
        const realMessage = MessageID.ascending()
        yield* publish(assistantInfo(info.id, realMessage), [userText(PartID.ascending(), "here is the answer")])

        yield* pollWithTimeout(
          Effect.sync(() => (synced(bodies, "part").length > 0 ? true : undefined)),
          "timed out waiting for share live sync",
          "5 seconds",
        )
        yield* Effect.sleep(50)

        expect(synced(bodies, "message").map((message) => message.id)).not.toContain(markerMessage)
        expect(synced(bodies, "part").map((part) => part.text)).toEqual(["here is the answer"])
      }).pipe(Effect.provide(userLayer(client)))
    }, ENTERPRISE),
  )

  it.live("announces a live user message with real content and drops its internal part", () =>
    provideTmpdirInstance(() => {
      const { bodies, client } = collect()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create({ title: "live mixed" })
        yield* register(info.id)
        const publish = yield* live(info.id)

        const message = MessageID.ascending()
        // The marker arrives first, as it does for a real auto-compacted turn.
        yield* publish(userInfo(info.id, message), [
          markerText(PartID.ascending()),
          userText(PartID.ascending(), "what did the build say?"),
        ])

        yield* pollWithTimeout(
          Effect.sync(() => (synced(bodies, "part").length > 0 ? true : undefined)),
          "timed out waiting for share live sync",
          "5 seconds",
        )
        yield* Effect.sleep(50)

        expect(synced(bodies, "message").map((item) => item.id)).toContain(message)
        expect(synced(bodies, "part").map((part) => part.text)).toEqual(["what did the build say?"])
      }).pipe(Effect.provide(userLayer(client)))
    }, ENTERPRISE),
  )

  it.live("keeps tool call and result pairing when a live message also carries a marker", () =>
    provideTmpdirInstance(() => {
      const { bodies, client } = collect()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create({ title: "live tool" })
        yield* register(info.id)
        const publish = yield* live(info.id)

        const message = MessageID.ascending()
        const toolPart = {
          id: PartID.ascending(),
          type: "tool",
          tool: "read",
          callID: "call_live",
          state: {
            status: "completed",
            input: { path: "a.ts" },
            output: "file body",
            title: "read a.ts",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        }
        yield* publish(userInfo(info.id, message), [
          { id: PartID.ascending(), type: "compaction", auto: true },
          toolPart,
        ])

        yield* pollWithTimeout(
          Effect.sync(() => (synced(bodies, "part").length > 0 ? true : undefined)),
          "timed out waiting for share live sync",
          "5 seconds",
        )
        yield* Effect.sleep(50)

        expect(synced(bodies, "message").map((item) => item.id)).toContain(message)
        expect(synced(bodies, "part")).toEqual([{ ...toolPart, messageID: message, sessionID: info.id }])
      }).pipe(Effect.provide(userLayer(client)))
    }, ENTERPRISE),
  )
})
