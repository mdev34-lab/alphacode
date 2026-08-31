import { describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CommandV2 } from "@opencode-ai/core/command"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Exit } from "effect"
import { testEffect } from "../lib/effect"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Command.node, CommandV2.node, Config.node, MCP.node, Skill.node])),
)

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

interface PromptServerState {
  name: string
  description: string
  text: string
  failGetPrompt: boolean
  getPromptCalls: number
}

// In-process MCP server advertising a single prompt and counting GetPrompt
// requests, so tests can assert when (and whether) prompt templates are
// resolved.
function promptServer(options?: Partial<PromptServerState>) {
  const state: PromptServerState = {
    name: "my-prompt",
    description: "A test prompt",
    text: "prompt result",
    failGetPrompt: false,
    getPromptCalls: 0,
    ...options,
  }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server(
        { name: "command-bridge-prompt", version: "1.0.0" },
        { capabilities: { prompts: {} } },
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      protocol.setRequestHandler(ListPromptsRequestSchema, () =>
        Promise.resolve({ prompts: [{ name: state.name, description: state.description }] }),
      )
      protocol.setRequestHandler(GetPromptRequestSchema, () => {
        state.getPromptCalls++
        if (state.failGetPrompt) throw new Error("prompt failed")
        return Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: state.text } }] })
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          return transport.handleRequest(request)
        },
      })
      return {
        state,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

describe("CommandV2 bridge", () => {
  it.instance("syncs factory default commands into CommandV2", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.list()
      const commandV2 = yield* CommandV2.Service
      const names = (yield* commandV2.list()).map((c) => c.name)
      expect(names).toContain("init")
      expect(names).toContain("review")

      const init = yield* commandV2.get("init")
      expect(init?.name).toBe("init")
      expect(init?.template).toContain("AGENTS.md")

      const review = yield* commandV2.get("review")
      expect(review?.name).toBe("review")
      expect(review?.template).toContain("review")
      expect(review?.subtask).toBe(true)
    }),
  )

  it.instance(
    "syncs configured command model, agent, subtask, and template into CommandV2",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        yield* command.list()
        const commandV2 = yield* CommandV2.Service
        const custom = yield* commandV2.get("my-cmd")
        expect(custom).toBeDefined()
        expect(custom?.agent).toBe("build")
        expect(custom?.subtask).toBe(true)
        expect(custom?.template).toBe("echo hello")
        expect(custom?.description).toBe("test command")
        // The legacy command model is a "provider/model" string, so the bridge
        // must split it into the V2 model reference. Legacy commands cannot
        // carry a variant, so none is bridged.
        expect(custom?.model).toBeDefined()
        expect(custom?.model?.id).toBe(ModelV2.ID.make("claude-3-opus-20240229"))
        expect(custom?.model?.providerID).toBe(ProviderV2.ID.make("anthropic"))
        expect(custom?.model?.variant).toBeUndefined()
      }),
    {
      config: {
        command: {
          "my-cmd": {
            agent: "build",
            model: "anthropic/claude-3-opus-20240229",
            description: "test command",
            template: "echo hello",
            subtask: true,
          },
        },
      },
    },
  )

  it.instance("bridges MCP prompt metadata without resolving the prompt", () =>
    Effect.gen(function* () {
      const server = yield* promptServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("lazy", remote(server.url))

      const command = yield* Command.Service
      yield* command.list()

      const commandV2 = yield* CommandV2.Service
      const bridged = yield* commandV2.get("lazy:my-prompt")
      expect(bridged).toBeDefined()
      expect(bridged?.description).toBe("A test prompt")
      // The template stays unresolved in the V2 store; command initialization
      // must not execute the remote prompt.
      expect(bridged?.template).toBe("")
      expect(server.state.getPromptCalls).toBe(0)

      // Lazy resolution still happens when the template is consumed.
      const legacy = yield* command.get("lazy:my-prompt")
      expect(legacy).toBeDefined()
      const template = yield* Effect.promise(async () => legacy!.template)
      expect(template).toBe("prompt result")
      expect(server.state.getPromptCalls).toBe(1)
    }),
  )

  it.instance("does not fail command initialization when an MCP prompt fails", () =>
    Effect.gen(function* () {
      const server = yield* promptServer({ failGetPrompt: true })
      const mcp = yield* MCP.Service
      yield* mcp.add("broken", remote(server.url))

      const command = yield* Command.Service
      const exit = yield* command.list().pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)

      const commandV2 = yield* CommandV2.Service
      const names = (yield* commandV2.list()).map((c) => c.name)
      expect(names).toContain("init")
      expect(names).toContain("review")
      expect(names).toContain("broken:my-prompt")
      expect(server.state.getPromptCalls).toBe(0)
    }),
  )
})
