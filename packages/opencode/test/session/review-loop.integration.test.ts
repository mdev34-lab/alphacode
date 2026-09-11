import { expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Fiber, Layer } from "effect"
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
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { ReviewLoop } from "../../src/session/review-loop"
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
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

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
    startAuth: () => Effect.die("unexpected MCP auth in review-loop integration tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-loop integration tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-loop integration tests"),
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

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const baseConfig = {
  agent: {
    general: { finishTool: false },
    plan: { finishTool: false },
  },
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
    },
  },
}

const useServerConfig = (reviewLoop?: { enabled?: boolean; max_iterations?: number; stall_limit?: number }) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...baseConfig,
        ...(reviewLoop ? { review_loop: reviewLoop } : {}),
        provider: {
          test: {
            ...baseConfig.provider.test,
            options: { apiKey: "test-key", baseURL: llm.url },
          },
        },
      }),
    )
    return { llm }
  })

const user = Effect.fn("reviewLoopIntegration.user")(function* (sessionID: SessionID, text: string, agent = "work") {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return message
})

const bodyString = (hit: { body: unknown }) => JSON.stringify(hit.body)
const policyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("Mandatory Review Loop") && !body.includes("Senior Code Reviewer")
}
const reviewMatch = (hit: { body: unknown }) => bodyString(hit).includes("Senior Code Reviewer")

const findingsReport = [
  "### Spec Compliance",
  "- ❌ Issues found: the test for the off-by-one is missing (src/cache.test.ts)",
  "",
  "#### Critical",
  "- None",
  "",
  "#### Important (Should Fix)",
  "- src/cache.test.ts: no test covers the corrected boundary",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
].join("\n")

const approvedReport = [
  "### Spec Compliance",
  "- ✅ Spec compliant",
  "",
  "#### Critical",
  "- None",
  "",
  "#### Important (Should Fix)",
  "- None found",
  "",
  "### Assessment",
  "**Ready to proceed?** Approved",
].join("\n")

const reviewDispatch = (prompt: string) => ({
  description: "Review cache fix",
  subagent_type: "review",
  background: false,
  prompt,
})

const nudgeCount = (messages: readonly SessionV1.WithParts[]) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text" && part.text.startsWith(ReviewLoop.NUDGE_MARKER)).length

const reviewTaskCount = (messages: readonly SessionV1.WithParts[]) =>
  messages
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "task" &&
        part.state.status !== "pending" &&
        part.state.input?.subagent_type === "review",
    ).length

it.instance(
  "driver blocks finish until review approves the latest changes",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Loop",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "done" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review the cache fix")))
      yield* llm.pushMatch(reviewMatch, reply().text(findingsReport).tool("finish", { result: "Needs fixes" }))
      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.test.ts", content: "test\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "added test" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("re-review only the fix diff")))
      yield* llm.pushMatch(reviewMatch, reply().text(approvedReport).tool("finish", { result: "Approved" }))

      yield* user(chat.id, "fix the cache key and add a test")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(reviewTaskCount(messages)).toBe(2)
      expect(nudgeCount(messages)).toBe(2)
      const capNotes = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith(ReviewLoop.CAP_MARKER))
      expect(capNotes).toHaveLength(0)
    }),
  30_000,
)

it.instance(
  "driver releases at the configured review-pass cap, not at the nudge count",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({ max_iterations: 2 })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Cap",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "first" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review attempt 1")))
      yield* llm.pushMatch(reviewMatch, reply().text(findingsReport).tool("finish", { result: "Needs fixes" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "second" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review attempt 2")))
      yield* llm.pushMatch(reviewMatch, reply().text(findingsReport).tool("finish", { result: "still blocked" }))

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(reviewTaskCount(messages)).toBe(2)
      expect(nudgeCount(messages)).toBe(2)
      const notes = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith(ReviewLoop.CAP_MARKER))
      expect(notes).toHaveLength(1)
      expect(notes[0]?.type === "text" ? notes[0].text : "").toContain("after 2 review pass(es)")
    }),
  30_000,
)

it.instance(
  "driver releases an ignored loop through the unresponsive backstop",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Ignore",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      for (let i = 0; i < 6; i++) {
        yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "attempt without review" }))
      }

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(reviewTaskCount(messages)).toBe(0)
      expect(nudgeCount(messages)).toBe(ReviewLoop.UNRESPONSIVE_NUDGE_LIMIT)
      const notes = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith(ReviewLoop.UNRESPONSIVE_MARKER))
      expect(notes).toHaveLength(1)
    }),
  30_000,
)

it.instance(
  "driver honors review_loop.enabled=false",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({ enabled: false })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Off",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "done" }))

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(nudgeCount(messages)).toBe(0)
      expect(reviewTaskCount(messages)).toBe(0)
    }),
  30_000,
)

it.instance(
  "driver does not gate conversational turns without file changes",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Chat",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().text("2 + 2 is 4.").tool("finish", { result: "answered" }))

      yield* user(chat.id, "what is 2+2?")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(nudgeCount(messages)).toBe(0)
    }),
  30_000,
)

it.instance(
  "driver publishes review status while the loop is active",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({
        title: "Status",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "x\n" }))
      yield* llm.hang
      yield* user(chat.id, "fix the cache")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(2), "timed out waiting for both model requests", "10 seconds")
      const observed = yield* awaitWithTimeout(
        Effect.gen(function* () {
          for (;;) {
            const current = yield* status.get(chat.id)
            if (current.type === "review") return current
            yield* Effect.sleep("50 millis")
          }
        }),
        "timed out waiting for review status",
        "10 seconds",
      )
      expect(observed.phase).toBe("work")
      expect(observed.cap).toBe(0)
      expect(observed.iteration).toBe(1)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  30_000,
)
