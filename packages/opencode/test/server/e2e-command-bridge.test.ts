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

function promptServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return Effect.runPromise(
    Effect.promise(async () => {
      const protocol = new Server({ name: "command-bridge", version: "1.0.0" }, { capabilities: { prompts: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      protocol.setRequestHandler(ListPromptsRequestSchema, () =>
        Promise.resolve({ prompts: [{ name: "my-prompt", description: "A test prompt" }] }),
      )
      protocol.setRequestHandler(GetPromptRequestSchema, () =>
        Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }),
      )
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          return transport.handleRequest(request)
        },
      })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
  )
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

  test("bridges MCP prompt commands into /api/command after legacy command init", async () => {
    const server = await promptServer()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: { mcp: { lazy: { type: "remote", url: server.url, oauth: false } } },
      })
      // Wait for the MCP client to connect (MCP state initializes on first use).
      let mcpStatus: Record<string, { status: string; error?: string }> = {}
      for (let i = 0; i < 50; i++) {
        const mcp = await request("/mcp", tmp.path)
        if (mcp.status === 200) mcpStatus = (await mcp.json()) as Record<string, { status: string }>
        if (mcpStatus["lazy"]?.status === "connected") break
        await Bun.sleep(200)
      }
      expect(mcpStatus["lazy"]?.status).toBe("connected")

      // The TUI's sync path calls the v1 command endpoint, which initializes
      // the legacy command state (and with it the V2 bridge).
      const v1 = await request("/command", tmp.path)
      expect(v1.status).toBe(200)
      const v1Body = (await v1.json()) as Array<{ name: string }>
      expect(v1Body.map((c) => c.name)).toContain("lazy:my-prompt")

      // The bridged command must be visible in the V2 store the TUI reads,
      // not only in the legacy v1 store.
      const response = await request("/api/command", tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Array<{ name: string; template?: string }> }
      const names = body.data.map((c) => c.name)
      expect(names).toContain("lazy:my-prompt")
    } finally {
      await server.close()
    }
  })
})
