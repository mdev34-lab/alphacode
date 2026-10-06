import { afterEach, describe, expect, it } from "bun:test"
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
  requestID,
  sessionID,
  type ZenFetch,
} from "@/provider/opencode-zen"

afterEach(async () => {
  await disposeAllInstances()
})

const itEffect = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const zenURL = "https://opencode.ai/zen/v1/chat/completions"
const ZEN_UUID = "11111111-1111-4111-8111-111111111111"

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
    it("prefixes a conversation session id and generates one without a caller", () => {
      expect(sessionID("ses_conversation")).toBe("ses_conversation")
      expect(sessionID("abc")).toBe("ses_abc")
      expect(sessionID(undefined, () => ZEN_UUID)).toBe(`ses_${ZEN_UUID}`)
      const sessions = uuids("first", "second")
      expect(sessionID(undefined, sessions)).not.toBe(sessionID(undefined, sessions))
    })

    it("regenerates request ids", () => {
      expect(requestID(() => ZEN_UUID)).toBe(`msg_${ZEN_UUID}`)
      expect(requestID()).toMatch(/^msg_[0-9a-f-]{36}$/)
      const requests = uuids("first", "second")
      expect(requestID(requests)).not.toBe(requestID(requests))
    })
  })

  describe("requests", () => {
    it("sends the client headers Zen verifies", async () => {
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

    it("keeps the caller session for a conversation and reuses the generated one without a caller", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream, uuid: uuids("first", "second") })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": "ses_thread" }, body })
      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": "ses_thread" }, body })
      await zen(zenURL, { method: "POST", body })
      await zen(zenURL, { method: "POST", body })

      const sessions = calls.map((call) => call.headers.get("x-opencode-session"))
      expect(sessions[0]).toBe("ses_thread")
      expect(sessions[1]).toBe("ses_thread")
      expect(sessions[2]).toMatch(/^ses_/)
      // Callers without a conversation id share the client's fallback thread.
      expect(sessions[3]).toBe(sessions[2])
    })

    it("authenticates free models with the public bearer token", async () => {
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

    it("authenticates the payload's config model id", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      // The gateway matches the payload's `model` field, i.e. the config model
      // id, so a differing API id must not unlock the public token.
      const zen = createFetch({ upstream, free: new Set(["config-id"]) })

      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "config-id", messages: [] }),
      })
      await zen(zenURL, {
        method: "POST",
        headers: { authorization: "Bearer sk" },
        body: JSON.stringify({ model: "api-id", messages: [] }),
      })

      expect(calls[0].headers.get("authorization")).toBe(ZEN_PUBLIC_AUTHENTICATION)
      expect(calls[1].headers.get("authorization")).toBe("Bearer sk")
    })

    it("enforces streaming and a normalized tool definition", async () => {
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

    it("leaves non-completion requests alone", async () => {
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

    it("forwards a non-JSON body untouched", async () => {
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

    it("rewrites a JSON body sent as bytes", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      await zen(zenURL, {
        method: "POST",
        body: encoder.encode(JSON.stringify({ model: "big-pickle", messages: [] })),
      })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body?.tools).toHaveLength(1)
    })

    it("honors an init body override over a Request body", async () => {
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

    it("keeps a Request method that has no init override", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(new Request("https://opencode.ai/zen/v1/models", { method: "GET" }))

      expect(calls[0].method).toBe("GET")
    })
  })

  describe("responses", () => {
    it("reassembles a stream for a non-streaming caller", async () => {
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

    it("reassembles reasoning and tool calls", async () => {
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

    it("keys tool calls by the streamed index instead of their position in a delta", async () => {
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

    it("leaves a streamed response untouched", async () => {
      const { upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }),
      })

      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toBe(completionStream)
    })

    it("propagates a stream error frame", async () => {
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

    it("does not report a truncated stream as success", async () => {
      const { upstream } = recorder(() => stream('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}', ""))
      const zen = createFetch({ upstream })

      await expect(
        zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }),
      ).rejects.toThrow("Zen stream ended before the completion finished")
    })

    it("keeps a missing finish reason distinct from a normal stop", async () => {
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

    it("fails a stalled stream once the chunk timeout elapses", async () => {
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

    it("cancels the upstream stream when the caller aborts", async () => {
      const controller = new AbortController()
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
      await Bun.sleep(20)
      controller.abort()

      await expect(pending).rejects.toThrow()
      // The Request's signal has to survive the rewrite to a URL request.
      expect(calls[0].init?.signal?.aborted).toBe(true)
    })
  })
})

itEffect.live("keeps the session header and regenerates the request header per turn", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepare = () =>
        LLMRequestPrep.prepare({
          user: {
            id: "msg_turn",
            sessionID: "ses_conversation",
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
          } as any,
          sessionID: "ses_conversation",
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

      expect(first["x-opencode-session"]).toBe("ses_conversation")
      expect(second["x-opencode-session"]).toBe("ses_conversation")
      expect(first["x-opencode-request"]).toMatch(/^msg_/)
      expect(second["x-opencode-request"]).toMatch(/^msg_/)
      expect(first["x-opencode-request"]).not.toBe(second["x-opencode-request"])
    }),
  ),
)

itEffect.live("keeps the Zen headers in front of model or plugin headers", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("deepseek-v4-flash-free"))
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: "msg_turn",
          sessionID: "ses_conversation",
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
        } as any,
        sessionID: "ses_conversation",
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
      expect(headers["x-opencode-session"]).toBe("ses_conversation")
      expect(headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(headers["x-opencode-request"]).not.toBe("msg_stale")
      expect(headers["User-Agent"]).not.toBe("stale")
    }),
  ),
)

itEffect.live("runs a non-streaming free-tier request through the opencode provider", () =>
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
              headers: { "x-opencode-session": "ses_conversation", "x-opencode-request": "msg_turn" },
            }),
          )

          expect(result.text).toBe("Hello world")
          expect(server.requests).toHaveLength(1)
          const request = server.requests[0]
          expect(request.headers.get("user-agent")).toBe(ZEN_USER_AGENT)
          expect(request.headers.get("x-opencode-client")).toBe("cli")
          expect(request.headers.get("x-opencode-project")).toBe("global")
          expect(request.headers.get("x-opencode-session")).toBe("ses_conversation")
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

itEffect.live("streams a free-tier response through the opencode provider", () =>
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
            headers: { "x-opencode-session": "ses_conversation", "x-opencode-request": "msg_turn" },
          })

          expect(yield* Effect.promise(() => result.text)).toBe("Hello world")
          expect(server.requests[0].headers.get("x-opencode-session")).toBe("ses_conversation")
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
