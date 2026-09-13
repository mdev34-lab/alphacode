import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import type { DelegationResult } from "../../src/tool/delegate-result"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in delegation integration tests"),
    authenticate: () => Effect.die("unexpected MCP auth in delegation integration tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in delegation integration tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const root = LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(root)

// Primary agents opt out of the finish tool so the scripted parent can end its
// turn with a plain text reply; the code child ends through the finish tool.
const cfg = {
  agent: {
    work: { finishTool: false },
    general: { finishTool: false },
    plan: { finishTool: false },
    // The code child ends its turn with a plain reply instead of the finish
    // tool. This keeps the test focused on delegation: the mandatory
    // work → review loop (which gates the finish tool after file-writing work)
    // is a separate feature and would otherwise block the child's finish.
    code: { finishTool: false },
  },
  // delegate is a deferred tool (not in CORE_TOOLS); always load it so the
  // scripted parent can call it without a tool_search round trip.
  tool_search: { always_load: ["delegate"] },
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const useServerConfig = Effect.gen(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      ...cfg,
      provider: {
        ...cfg.provider,
        test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: llm.url } },
      },
    }),
  )
  return { dir, llm }
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string, agent = "work") {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const bodyString = (hit: { body: unknown }) => JSON.stringify(hit.body)

// The delegation contract the delegate tool injects as the child's user message.
const childMatch = (hit: { body: unknown }) => bodyString(hit).includes("isolated delegate of another agent")
// The parent's own request, distinguished by the user message we send it.
const parentMatch = (hit: { body: unknown }) => bodyString(hit).includes("Delegate this to the code agent")

// Pull the delegate tool's machine-readable result out of the parent's parts.
const delegateResult = Effect.fn("test.delegateResult")(function* (sessionID: SessionID) {
  const messages = yield* MessageV2.filterCompactedEffect(sessionID)
  const part = messages
    .flatMap((msg) => msg.parts)
    .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "delegate")
  expect(part).toBeDefined()
  if (!part || part.state.status !== "completed") throw new Error("expected a completed delegate tool part")
  return JSON.parse(part.state.output) as DelegationResult
})

// The end-to-end path the unit tests stub: the parent loop calls the real
// delegate tool, which spawns a real child session that runs its own real
// prompt loop against the test LLM, executes real tools, and whose transcript
// is derived back into the parent's result.
it.instance(
  "delegation runs a real child that mutates a fixture and returns a derived result",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const target = path.join(dir, "hello.txt")

      // Parent dispatches the delegate tool; the child writes a real file,
      // then ends its turn with a plain reply (finish tool disabled for the
      // code child — see cfg).
      yield* llm.pushMatch(parentMatch, reply().tool("delegate", { agent: "code", task: "Create the file" }))
      yield* llm.pushMatch(childMatch, reply().tool("write", { filePath: target, content: "hello" }))

      const chat = yield* sessions.create({
        title: "Delegation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "Delegate this to the code agent")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // A real child session ran under the parent, on the code agent.
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.agent).toBe("code")

      // The child actually mutated the fixture on disk.
      expect(yield* fs.readFileString(target)).toBe("hello")

      // The parent received the derived, machine-readable result: the changed
      // file is an observed fact from the child's write, not a self-report.
      const reported = yield* delegateResult(chat.id)
      expect(reported.status).toBe("completed")
      expect(reported.changedFiles).toContain(target)
    }),
  30_000,
)

it.instance(
  "read-only delegation prevents a live child from mutating",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const target = path.join(dir, "blocked.txt")

      // Parent dispatches a read-only delegation; the child attempts a write.
      yield* llm.pushMatch(
        parentMatch,
        reply().tool("delegate", { agent: "code", task: "Create the file", constraints: { readOnly: true } }),
      )
      yield* llm.pushMatch(childMatch, reply().tool("write", { filePath: target, content: "should not exist" }))

      const chat = yield* sessions.create({
        title: "Read-only delegation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "Delegate this to the code agent")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const kid = yield* sessions.children(chat.id)
      expect(kid).toHaveLength(1)

      // The sandbox hides the mutating tools from the child, so its live write
      // was blocked and nothing was written to disk.
      expect(yield* fs.exists(target)).toBe(false)

      // No completed write occurred in the child's transcript: the attempt was
      // rejected, not executed.
      const childID = kid[0]?.id
      if (!childID) throw new Error("expected a child session")
      const messages = yield* MessageV2.filterCompactedEffect(childID)
      const completedWrites = messages
        .flatMap((msg) => msg.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "write")
        .filter((part) => part.state.status === "completed")
      expect(completedWrites).toHaveLength(0)
    }),
  30_000,
)

it.instance(
  "delegation timeout cancels a live child",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service

      // Parent dispatches a short-deadline delegation; the child's model
      // request hangs, so the deadline must win and cancel the live child.
      yield* llm.pushMatch(
        parentMatch,
        reply().tool("delegate", { agent: "code", task: "Slow task", timeoutMs: 300 }),
      )
      yield* llm.pushMatch(childMatch, reply().pendingTool("write", { filePath: "/tmp/x", content: "x" }).hang())

      const chat = yield* sessions.create({
        title: "Timeout delegation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "Delegate this to the code agent")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const reported = yield* delegateResult(chat.id)
      expect(reported.status).toBe("timeout")

      // The child session was created and then cancelled, not completed.
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
    }),
  30_000,
)
