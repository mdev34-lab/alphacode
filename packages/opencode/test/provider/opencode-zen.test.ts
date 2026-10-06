import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { generateText, streamText } from "ai"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { LLMRequestPrep } from "@/session/llm/request"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import {
  ZEN_PUBLIC_AUTHENTICATION,
  ZEN_USER_AGENT,
  createFetch,
  freeTier,
  requestID,
  sessionID,
  type ZenFetch,
} from "@/provider/opencode-zen"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const zenURL = "https://opencode.ai/zen/v1/chat/completions"
const ZEN_UUID = "11111111-1111-4111-8111-111111111111"
// A session id as `Identifier.create` generates it: 12 hex timestamp chars
// followed by 14 base 62 chars. These are not UUIDs.
const SESSION_ID = "ses_1134d213e0014q5ohvhfGiiuCj"

const encoder = new TextEncoder()

const completionStream = [
  'data: {"id":"chatcmpl-1","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
  "",
  "data: [DONE]",
  "",
].join("\n")

type Captured = {
  url: string
  method: string
  headers: Headers
  /** The JSON body the adapter sent, when it sent one. */
  body: Record<string, any> | undefined
  /** The raw body fetch received, so tests can assert byte-for-byte forwarding. */
  raw: RequestInit["body"] | undefined
  init: RequestInit | undefined
}

function recorder(handler: (input: URL | RequestInfo, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const upstream: ZenFetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers),
      body: jsonBody(init?.body),
      raw: init?.body,
      init,
    })
    return handler(input, init)
  }
  return { calls, upstream }
}

function jsonBody(body: RequestInit["body"] | undefined) {
  if (typeof body !== "string") return undefined
  try {
    const value = JSON.parse(body)
    return typeof value === "object" && value !== null ? (value as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

function sse() {
  return new Response(completionStream, { headers: { "content-type": "text/event-stream" } })
}

function stream(...lines: string[]) {
  return new Response(lines.join("\n"), { headers: { "content-type": "text/event-stream" } })
}

function uuids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `uuid-${index}`
}

describe("OpenCodeZen", () => {
  describe("ids", () => {
    test("keeps a workspace session id, a UUID, and a bare UUID", () => {
      expect(sessionID(SESSION_ID)).toBe(SESSION_ID)
      expect(sessionID(`ses_${ZEN_UUID}`)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID(ZEN_UUID, () => "unused")).toBe(`ses_${ZEN_UUID}`)
    })

    test("replaces an invalid session id instead of forwarding it", () => {
      expect(sessionID("ses_invalid", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID("ses_conversation", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID("", () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      expect(sessionID(undefined, () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      const sessions = uuids("first", "second")
      expect(sessionID(undefined, sessions)).not.toBe(sessionID(undefined, sessions))
    })

    test("only treats fully zero-cost models as free and keys them by wire id", () => {
      const costs = { input: 0, output: 0, cache: { read: 0, write: 0 } }
      expect(
        [
          ...freeTier([
            { api: { id: "wire/free" }, cost: costs },
            { api: { id: "wire/free-alias" }, cost: costs },
            { api: { id: "wire/paid-output" }, cost: { ...costs, output: 5 } },
            { api: { id: "wire/paid-cache" }, cost: { ...costs, cache: { read: 0.1, write: 0 } } },
            {
              api: { id: "wire/paid-tier" },
              cost: {
                ...costs,
                tiers: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
              },
            },
            {
              api: { id: "wire/paid-over-200k" },
              cost: {
                ...costs,
                experimentalOver200K: { input: 2, output: 4, cache: { read: 0, write: 0 } },
              },
            },
          ]),
        ].sort(),
      ).toEqual(["wire/free", "wire/free-alias"])
    })

    test("regenerates request ids", () => {
      expect(requestID(() => ZEN_UUID)).toBe(`msg_${ZEN_UUID}`)
      expect(requestID()).toMatch(/^msg_[0-9a-f-]{36}$/)
      const requests = uuids("first", "second")
      expect(requestID(requests)).not.toBe(requestID(requests))
    })
  })

  describe("requests", () => {
    test("sends the client headers Zen verifies", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, uuid: () => ZEN_UUID })

      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls).toHaveLength(1)
      expect(calls[0].headers.get("user-agent")).toBe(ZEN_USER_AGENT)
      expect(calls[0].headers.get("x-opencode-client")).toBe("cli")
      expect(calls[0].headers.get("x-opencode-project")).toBe("global")
      expect(calls[0].headers.get("x-opencode-session")).toBe(`ses_${ZEN_UUID}`)
      expect(calls[0].headers.get("x-opencode-request")).toBe(`msg_${ZEN_UUID}`)
    })

    test("keeps a caller session and gives each caller without one its own session", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, uuid: uuids("first", "second") })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": SESSION_ID }, body })
      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": SESSION_ID }, body })
      await zen(zenURL, { method: "POST", body })
      await zen(zenURL, { method: "POST", body })

      const sessions = calls.map((call) => call.headers.get("x-opencode-session"))
      expect(sessions[0]).toBe(SESSION_ID)
      expect(sessions[1]).toBe(SESSION_ID)
      // Callers without a conversation id get a session per request instead of
      // sharing one client-wide id.
      expect(sessions[2]).toMatch(/^ses_/)
      expect(sessions[2]).not.toBe(SESSION_ID)
      expect(sessions[3]).not.toBe(SESSION_ID)
      expect(sessions[3]).not.toBe(sessions[2])
    })

    test("authenticates free models with the public bearer token", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, free: new Set(["deepseek-v4-flash-free"]) })
      const headers = { authorization: "Bearer sk-secret" }

      await zen(zenURL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
      })
      await zen(zenURL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
      })

      expect(calls[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
      expect(calls[1].headers.get("authorization")).toBe("Bearer sk-secret")
    })

    test("authenticates only the model id carried in the payload", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      // Free-tier ids are wire ids, so eligibility follows the request's `model`
      // field: an id outside the set must keep the caller's own key.
      const zen = createFetch({ upstream, free: new Set(["wire/id"]) })

      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "wire/id", messages: [] }),
      })
      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "other/id", messages: [] }),
      })

      expect(calls[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
      expect(calls[1].headers.get("authorization")).toBe("Bearer sk")
    })

    test("enforces streaming and a normalized tool definition", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body?.tools).toHaveLength(1)
      expect(calls[0].body?.tool_choice).toBe("auto")

      // A tool choice that the placeholder cannot satisfy would be rejected.
      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [], tool_choice: "required" }),
      })

      expect(calls[1].body?.tools).toHaveLength(1)
      expect(calls[1].body?.tool_choice).toBe("auto")

      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [{ type: "function" }] }),
      })

      expect(calls[2].body?.tools).toEqual([{ type: "function" }])
      expect(calls[2].body?.tool_choice).toBeUndefined()
    })

    test("leaves non-completion requests alone", async () => {
      const { calls, upstream } = recorder(() => Response.json({ data: [] }))
      const zen = createFetch({ upstream })

      await zen("https://opencode.ai/zen/v1/models", { method: "GET" })
      await zen("https://opencode.ai/zen/v1/models")

      expect(calls[0].method).toBe("GET")
      expect(calls[0].body).toBeUndefined()
      // A plain fetch defaults to GET; the adapter must not turn it into a POST.
      expect(calls[1].method).toBe("GET")
      expect(calls[1].body).toBeUndefined()
      expect(calls[1].headers.get("x-opencode-session")).toMatch(/^ses_/)
    })

    test("forwards a non-JSON body untouched", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const bytes = new Uint8Array([0, 255, 16])

      await zen(zenURL, { method: "POST", body: bytes })
      await zen(zenURL, { method: "POST", body: "not json" })

      expect(calls[0].raw).toBe(bytes)
      expect(calls[0].body).toBeUndefined()
      expect(calls[1].raw).toBe("not json")
      expect(calls[1].body).toBeUndefined()
    })

    test("rewrites a JSON body sent as bytes", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      await zen(zenURL, {
        method: "POST",
        body: encoder.encode(JSON.stringify({ model: "big-pickle", messages: [] })),
      })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body?.tools).toHaveLength(1)
    })

    test("honors an init body override over a Request body", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "original" }] }),
      })

      await zen(request, { body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }) })

      expect(calls[0].body?.messages).toEqual([])
      expect(calls[0].body?.stream).toBe(true)
    })

    test("honors an explicit null body override", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })

      await zen(request, { body: null })

      expect(calls[0].raw).toBeNull()
      expect(calls[0].body).toBeUndefined()
    })

    test("drops a stale content-length when it rewrites the body", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })

      expect(calls[0].headers.get("content-length")).toBeNull()
      expect(calls[0].body?.stream).toBe(true)
    })

    test("builds headers from the effective list instead of reviving a dropped Authorization header", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, free: new Set(["big-pickle"]) })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-secret" },
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
      })

      await zen(request, { headers: { "content-type": "application/json" } })

      expect(calls[0].headers.get("authorization")).toBeNull()
      expect(calls[0].headers.get("x-opencode-session")).toMatch(/^ses_/)
    })

    test("keeps a Request method that has no init override", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(new Request("https://opencode.ai/zen/v1/models", { method: "GET" }))

      expect(calls[0].method).toBe("GET")
    })
  })

  describe("responses", () => {
    test("reassembles a stream for a non-streaming caller", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
      })

      expect(calls[0].body?.stream).toBe(true)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "deepseek-v4-flash-free",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello world" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })
    })

    test("reassembles reasoning and tool calls", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })
      const body = (await response.json()) as {
        choices: Array<{ message: { reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string }>
      }

      expect(body.choices[0].message.reasoning_content).toBe("think")
      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
      ])
      expect(body.choices[0].finish_reason).toBe("tool_calls")
    })

    test("keys tool calls by the streamed index instead of their position in a delta", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"grep","arguments":""}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"q\\":\\"x\\"}"}}]}}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })
      const body = (await response.json()) as { choices: Array<{ message: { tool_calls?: unknown[] } }> }

      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_a", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
        { id: "call_b", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } },
      ])
    })

    test("leaves a streamed response untouched", async () => {
      const { upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }),
      })

      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toBe(completionStream)
    })

    test("propagates a stream error frame", async () => {
      const { upstream } = recorder(() =>
        stream(
          'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
          "",
          'data: {"error":{"message":"upstream exploded","type":"server_error"}}',
          "",
        ),
      )
      const zen = createFetch({ upstream })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("Zen stream error: upstream exploded")
    })

    test("does not report a truncated stream as success", async () => {
      const { upstream } = recorder(() => stream('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}', ""))
      const zen = createFetch({ upstream })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("Zen stream ended before the completion finished")
    })

    test("keeps a missing finish reason distinct from a normal stop", async () => {
      const { upstream } = recorder(() =>
        stream('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}', "", "data: [DONE]", ""),
      )
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      })
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string | null }>
      }

      expect(body.choices[0].message.content).toBe("half")
      expect(body.choices[0].finish_reason).toBeNull()
    })

    test("fails a stalled stream once the chunk timeout elapses", async () => {
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream, chunkTimeout: 25 })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("stalled")
    })

    test("cancels the upstream stream when the caller aborts", async () => {
      const controller = new AbortController()
      const reading = Promise.withResolvers<void>()
      const { calls, upstream } = recorder(
        (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
                init?.signal?.addEventListener(
                  "abort",
                  () => stream.error(init.signal?.reason ?? new Error("aborted")),
                  { once: true },
                )
              },
              pull() {
                // The adapter is waiting for the next chunk when pull runs.
                reading.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      const pending = zen(request)
      await reading.promise
      controller.abort()

      await expect(pending).rejects.toThrow()
      // The Request's signal has to survive the rewrite to a URL request.
      expect(calls[0].init?.signal?.aborted).toBe(true)
    })

    test("rejects a pre-aborted caller signal without waiting for the upstream", async () => {
      const controller = new AbortController()
      controller.abort(new Error("caller cancelled"))
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
                // The stream never closes and never reacts to the abort.
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      const outcome = await Promise.race([
        zen(request).then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
        // Bounds the wait so an implementation that hangs fails here instead of
        // timing the whole test out.
        Bun.sleep(500).then(() => "still reading" as const),
      ])

      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe("caller cancelled")
    })

    test("cancels the upstream body when a pending read is aborted", async () => {
      const controller = new AbortController()
      const reading = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<void>()
      const { upstream } = recorder(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'))
              },
              pull() {
                reading.resolve()
              },
              // The upstream never reacts to the abort itself.
              cancel() {
                cancelled.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      const zen = createFetch({ upstream })
      const request = new Request(zenURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: false }),
        signal: controller.signal,
      })

      const pending = zen(request)
      await reading.promise
      controller.abort()

      await expect(pending).rejects.toThrow()
      await cancelled.promise
    })
  })
})

it.live("keeps the session header and regenerates the request header per turn", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepare = () =>
        LLMRequestPrep.prepare({
          user: {
            id: "msg_turn",
            sessionID: SESSION_ID,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
          } as any,
          sessionID: SESSION_ID,
          model,
          agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
          system: [],
          messages: [{ role: "user", content: "hello" }],
          tools: {},
          provider: { id: "opencode", options: {} } as any,
          auth: undefined,
          plugin: {
            trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          } as any,
          flags: { outputTokenMax: 32_000, client: "cli" } as any,
          isWorkflow: false,
        })

      const first = (yield* prepare()).headers as Record<string, string | undefined>
      const second = (yield* prepare()).headers as Record<string, string | undefined>

      expect(first["x-opencode-session"]).toBe(SESSION_ID)
      expect(second["x-opencode-session"]).toBe(SESSION_ID)
      expect(first["x-opencode-request"]).toMatch(/^msg_/)
      expect(second["x-opencode-request"]).toMatch(/^msg_/)
      expect(first["x-opencode-request"]).not.toBe(second["x-opencode-request"])
    }),
  ),
)

it.live("keeps the Zen headers in front of model or plugin headers", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: "msg_turn",
          sessionID: SESSION_ID,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
        } as any,
        sessionID: SESSION_ID,
        model: { ...model, headers: { "x-opencode-session": "ses_stale", "User-Agent": "stale" } },
        agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        provider: { id: "opencode", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: Record<string, any>) => {
            const headers = { ...output["headers"], "x-opencode-request": "msg_stale" }
            return Effect.succeed({ ...output, headers })
          },
        } as any,
        flags: { outputTokenMax: 32_000, client: "cli" } as any,
        isWorkflow: false,
      })

      const headers = prepared.headers as Record<string, string | undefined>
      expect(headers["x-opencode-session"]).toBe(SESSION_ID)
      expect(headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(headers["x-opencode-request"]).not.toBe("msg_stale")
      expect(headers["User-Agent"]).not.toBe("stale")
    }),
  ),
)

it.live("runs a non-streaming free-tier request through the opencode provider", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
          const language = yield* provider.getLanguage(model)
          const result = yield* Effect.promise(() =>
            generateText({
              model: language,
              messages: [{ role: "user", content: "hello" }],
              headers: { "x-opencode-session": SESSION_ID, "x-opencode-request": "msg_turn" },
            }),
          )

          expect(result.text).toBe("Hello world")
          expect(server.requests).toHaveLength(1)
          const request = server.requests[0]
          expect(request.headers.get("user-agent")).toBe(ZEN_USER_AGENT)
          expect(request.headers.get("x-opencode-client")).toBe("cli")
          expect(request.headers.get("x-opencode-project")).toBe("global")
          expect(request.headers.get("x-opencode-session")).toBe(SESSION_ID)
          expect(request.headers.get("x-opencode-request")).toBe("msg_turn")
          expect(request.headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
          expect(request.body?.stream).toBe(true)
          expect(request.body?.tools).toHaveLength(1)
          expect(request.body?.model).toBe("deepseek-v4-flash-free")
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

const zenRequest = (modelID: string) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make(modelID))
          const language = yield* provider.getLanguage(model)
          yield* Effect.promise(() => generateText({ model: language, messages: [{ role: "user", content: "hello" }] }))
        }),
      { config: zenProviderConfig(server.url) },
    )
    return server.requests[0]
  })

it.live("keeps the caller API key for paid models", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("paid-sonnet")

    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
    expect(request.body?.stream).toBe(true)
  }),
)

it.live("never authenticates a zero-input model with priced output as free", () =>
  Effect.gen(function* () {
    const request = yield* zenRequest("zero-input-paid")

    expect(request.body?.model).toBe("zero-input-paid")
    expect(request.headers.get("authorization")).toBe("Bearer sk-secret")
  }),
)

it.live("authenticates a free model through its wire model id", () =>
  Effect.gen(function* () {
    // The config alias is not a Zen model id, and no model is configured under
    // the wire id, so only wire-id metadata can mark this request free.
    const request = yield* zenRequest("free-alias")

    expect(request.body?.model).toBe("team-wire-free")
    expect(request.headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
  }),
)

it.live("streams a free-tier response through the opencode provider", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => zenServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("big-pickle"))
          const language = yield* provider.getLanguage(model)
          const result = streamText({
            model: language,
            messages: [{ role: "user", content: "hello" }],
            headers: { "x-opencode-session": SESSION_ID, "x-opencode-request": "msg_turn" },
          })

          expect(yield* Effect.promise(() => result.text)).toBe("Hello world")
          expect(server.requests[0].headers.get("x-opencode-session")).toBe(SESSION_ID)
          expect(server.requests[0].body?.stream).toBe(true)
        }),
      { config: zenProviderConfig(server.url) },
    )
  }),
)

function zenProviderConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      opencode: {
        options: { baseURL: url, apiKey: "sk-secret" },
        models: {
          "deepseek-v4-flash-free": {
            name: "DeepSeek Flash Free",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
          "big-pickle": {
            name: "Big Pickle",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
          "free-alias": {
            id: "team-wire-free",
            name: "Aliased Free",
            tool_call: true,
            cost: { input: 0, output: 0 },
          },
          "zero-input-paid": {
            name: "Priced Output",
            tool_call: true,
            cost: { input: 0, output: 5 },
            limit: { context: 100_000, output: 10_000 },
          },
          "paid-sonnet": {
            name: "Paid",
            tool_call: true,
            cost: { input: 3, output: 15 },
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    },
  }
}

async function zenServer(): Promise<{ server: Server; url: string; requests: Captured[] }> {
  const requests: Captured[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        method: request.method ?? "GET",
        headers: new Headers(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, String(value)] as [string, string]],
          ),
        ),
        body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString()),
        raw: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        init: undefined,
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(completionStream)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}`, requests }
}
