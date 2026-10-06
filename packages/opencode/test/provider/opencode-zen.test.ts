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

type Captured = { url: string; headers: Headers; body: Record<string, any> | undefined }

function recorder(response: () => Response) {
  const calls: Captured[] = []
  const upstream: ZenFetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return response()
  }
  return { calls, upstream }
}

function sse() {
  return new Response(completionStream, { headers: { "content-type": "text/event-stream" } })
}

describe("OpenCodeZen", () => {
  describe("ids", () => {
    it("keeps a conversation session id and prefixes it when needed", () => {
      expect(sessionID("ses_conversation")).toBe("ses_conversation")
      expect(sessionID("abc")).toBe("ses_abc")
      expect(sessionID(undefined)).not.toBe(sessionID(undefined))
      expect(sessionID(undefined)).toMatch(/^ses_[0-9a-f-]{36}$/)
    })

    it("regenerates request ids", () => {
      const first = requestID()
      expect(first).toMatch(/^msg_[0-9a-f-]{36}$/)
      expect(requestID()).not.toBe(first)
    })
  })

  describe("requests", () => {
    it("sends the client headers Zen verifies", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })

      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls).toHaveLength(1)
      expect(calls[0].headers.get("user-agent")).toBe(ZEN_USER_AGENT)
      expect(calls[0].headers.get("x-opencode-client")).toBe("cli")
      expect(calls[0].headers.get("x-opencode-project")).toBe("global")
      expect(calls[0].headers.get("x-opencode-session")).toMatch(/^ses_/)
      expect(calls[0].headers.get("x-opencode-request")).toMatch(/^msg_/)
    })

    it("keeps the caller session for a conversation and reuses the generated one without a caller", async () => {
      const { calls, upstream } = recorder(() => Response.json({ ok: true }))
      const zen = createFetch({ upstream })
      const body = JSON.stringify({ model: "big-pickle", messages: [], stream: true })

      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": "ses_thread" }, body })
      await zen(zenURL, { method: "POST", headers: { "x-opencode-session": "ses_thread" }, body })
      await zen(zenURL, { method: "POST", body })
      await zen(zenURL, { method: "POST", body })

      const sessions = calls.map((call) => call.headers.get("x-opencode-session"))
      expect(sessions[0]).toBe("ses_thread")
      expect(sessions[1]).toBe("ses_thread")
      expect(sessions[2]).toMatch(/^ses_/)
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

    it("enforces streaming and a tool definition", async () => {
      const { calls, upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(calls[0].body?.stream).toBe(true)
      expect(calls[0].body?.tools).toHaveLength(1)
      expect(calls[0].body?.tool_choice).toBe("auto")

      await zen(zenURL, {
        method: "POST",
        body: JSON.stringify({ model: "big-pickle", messages: [], tools: [{ type: "function" }] }),
      })

      expect(calls[1].body?.tools).toEqual([{ type: "function" }])
      expect(calls[1].body?.tool_choice).toBeUndefined()
    })

    it("leaves non-completion requests alone", async () => {
      const { calls, upstream } = recorder(() => Response.json({ data: [] }))
      const zen = createFetch({ upstream })

      await zen("https://opencode.ai/zen/v1/models", { method: "GET" })

      expect(calls[0].body).toBeUndefined()
      expect(calls[0].headers.get("x-opencode-session")).toMatch(/^ses_/)
    })
  })

  describe("responses", () => {
    it("reassembles a stream for a non-streaming caller", async () => {
      const { upstream } = recorder(() => sse())
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })

      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({
        id: "chatcmpl-1",
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
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n")
      const { upstream } = recorder(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }))
      const zen = createFetch({ upstream })

      const response = await zen(zenURL, { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) })
      const body = (await response.json()) as {
        choices: Array<{ message: { reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string }>
      }

      expect(body.choices[0].message.reasoning_content).toBe("think")
      expect(body.choices[0].message.tool_calls).toEqual([
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: '{"cmd":"ls"}' },
        },
      ])
      expect(body.choices[0].finish_reason).toBe("tool_calls")
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
        headers: new Headers(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, String(value)] as [string, string]],
          ),
        ),
        body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString()),
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
