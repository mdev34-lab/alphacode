import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Context, Effect } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { ...init, headers }),
    context,
  )
}

// In-process MCP server advertising a single prompt, counting GetPrompt
// requests so the test can assert when (and how often) the prompt resolves.
function promptServer(): Promise<{ url: string; getPromptCalls: () => number; close: () => Promise<void> }> {
  return Effect.runPromise(
    Effect.promise(async () => {
      let getPromptCalls = 0
      const protocol = new Server({ name: "command-bridge", version: "1.0.0" }, { capabilities: { prompts: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      protocol.setRequestHandler(ListPromptsRequestSchema, () =>
        Promise.resolve({ prompts: [{ name: "my-prompt", description: "A test prompt" }] }),
      )
      protocol.setRequestHandler(GetPromptRequestSchema, () => {
        getPromptCalls++
        return Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] })
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          return transport.handleRequest(request)
        },
      })
      return {
        url: http.url.toString(),
        getPromptCalls: () => getPromptCalls,
        close: async () => {
          await protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
  )
}

// Minimal OpenAI-compatible chat completions endpoint that always replies
// with a single "done" turn, so command execution completes without a real
// model.
function llmServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const line = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  const chunk = (input: { delta?: Record<string, unknown>; finish?: string }) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta: input.delta ?? {}, ...(input.finish ? { finish_reason: input.finish } : {}) }],
  })
  const http = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
        return new Response(
          [line(chunk({ delta: { role: "assistant", content: "done" } })), line(chunk({ finish: "stop" })), "data: [DONE]\n\n"].join(
            "",
          ),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return Promise.resolve({
    url: `${http.url}/v1`,
    close: async () => {
      await http.stop(true)
    },
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 command endpoint", () => {
  test("serves factory and configured commands", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { command: { "my-cmd": { template: "echo hello", description: "test command" } } },
    })
    const response = await request("/api/command", tmp.path)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ name: string }> }
    const names = body.data.map((c) => c.name)
    expect(names).toContain("init")
    expect(names).toContain("review")
    expect(names).toContain("my-cmd")
  })

  test("bridges MCP prompt commands into /api/command and executes them through the session command endpoint", async () => {
    const mcp = await promptServer()
    const llm = await llmServer()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          // The default agent requires the finish tool to end a turn; a plain
          // text reply from the fake LLM must end it instead.
          agent: { work: { finishTool: false }, general: { finishTool: false }, plan: { finishTool: false } },
          mcp: { lazy: { type: "remote", url: mcp.url, oauth: false } },
          provider: {
            test: {
              name: "Test",
              id: "test",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  attachment: false,
                  reasoning: false,
                  temperature: false,
                  tool_call: true,
                  release_date: "2025-01-01",
                  limit: { context: 100000, output: 10000 },
                  cost: { input: 0, output: 0 },
                  options: {},
                },
              },
              options: { apiKey: "test-key", baseURL: llm.url },
            },
          },
        },
      })
      // Wait for the MCP client to connect (MCP state initializes on first use).
      let mcpStatus: Record<string, { status: string; error?: string }> = {}
      for (let i = 0; i < 50; i++) {
        const status = await request("/mcp", tmp.path)
        if (status.status === 200) mcpStatus = (await status.json()) as Record<string, { status: string }>
        if (mcpStatus["lazy"]?.status === "connected") break
        await Bun.sleep(200)
      }
      expect(mcpStatus["lazy"]?.status).toBe("connected")
      // Connecting the MCP client does not resolve its prompts.
      expect(mcp.getPromptCalls()).toBe(0)

      // Discovery: the TUI's sync path (v1) and the V2 store (v2) both list
      // the bridged MCP command.
      const v1 = await request("/command", tmp.path)
      expect(v1.status).toBe(200)
      expect(((await v1.json()) as Array<{ name: string }>).map((c) => c.name)).toContain("lazy:my-prompt")
      const v2 = await request("/api/command", tmp.path)
      expect(v2.status).toBe(200)
      expect(((await v2.json()) as { data: Array<{ name: string }> }).data.map((c) => c.name)).toContain(
        "lazy:my-prompt",
      )
      // Note: the pre-existing v1 list response serializes the lazy MCP
      // template getter as {} (evaluating it in the process), so one GetPrompt
      // may be in flight after discovery. Let any in-flight requests settle
      // and count only what execution itself triggers.
      let calls = mcp.getPromptCalls()
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(50)
        const current = mcp.getPromptCalls()
        if (current === calls) break
        calls = current
      }

      // Execution: the TUI executes a launcher selection via
      // POST /session/:id/command.
      const created = await request("/session", tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { id: "test-model", providerID: "test" } }),
      })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      const executed = await request(`/session/${session.id}/command`, tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "lazy:my-prompt", arguments: "" }),
      })
      expect(executed.status).toBe(200)

      // Execution resolved the MCP prompt exactly once, on top of whatever
      // discovery had already triggered...
      expect(mcp.getPromptCalls()).toBe(calls + 1)
      // ...and the MCP response is what the session received, not the empty
      // template stored in the V2 view.
      const messages = await request(`/session/${session.id}/message`, tmp.path)
      expect(messages.status).toBe(200)
      const list = (await messages.json()) as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
      const userText = list
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      expect(userText).toContain("prompt result")
    } finally {
      await mcp.close()
      await llm.close()
    }
  })
})
