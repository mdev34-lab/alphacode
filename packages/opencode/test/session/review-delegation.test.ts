import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
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
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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
    startAuth: () => Effect.die("unexpected MCP auth in review-delegation tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-delegation tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-delegation tests"),
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

// Finish stays enabled for `review` so the subagent path exercised here matches
// production (subagents end their turn through the finish tool). The primary
// agents opt out so scripted text-only replies can end their turns; `custom`
// is a non-default primary agent used as the control arm for delegation.
const cfg = {
  agent: {
    work: { finishTool: false },
    general: { finishTool: false },
    plan: { finishTool: false },
    custom: { finishTool: false, mode: "primary" as const },
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

const toolNames = (hit: { body: unknown }) =>
  ((hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? [])
    .map((tool) => tool.function?.name ?? "")
    .toSorted()

// A primary-agent request that carries the delegation policy, and one that
// does not. Title requests are auto-answered by the test server and never
// reach these matchers.
const policyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("## Review Loop") && !body.includes("Senior Code Reviewer")
}

const noPolicyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("You are opencode") && !body.includes("## Review Loop")
}

const reviewMatch = (hit: { body: unknown }) => bodyString(hit).includes("Senior Code Reviewer")

const REVIEW_REPORT = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "The cache lookup skips the first entry, so cached reads miss.",
  findings: [
    {
      severity: "important",
      title: "Off-by-one skips the first cache entry",
      file: "src/cache.ts",
      line: 42,
      detail: "The loop must start at 0.",
    },
  ],
}
const REPORT = [
  "### Spec Compliance",
  "- ❌ Issues found: cache key drops the tenant prefix (src/cache.ts:42)",
  "",
  "#### Important (Should Fix)",
  "- src/cache.ts:42: off-by-one skips the first cache entry; the loop must start at 0",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
  "",
  "<alphacode-review>",
  JSON.stringify(REVIEW_REPORT, null, 2),
  "</alphacode-review>",
].join("\n")

const TASK_PROMPT = [
  "What was requested: fix the off-by-one in the cache key and add a test.",
  "What changed: src/cache.ts, src/cache.test.ts",
  "Boundary: uncommitted working tree, expected files src/cache.ts and src/cache.test.ts",
  "Diff: @@ -41,7 +41,7 @@ for (let i = 1; i <= entries.length; i++) {",
].join("\n")

const scriptPolicyFollowingModel = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  yield* llm.pushMatch(
    policyMatch,
    reply().tool("task", {
      description: "Review cache fix",
      subagent_type: "review",
      background: false,
      prompt: TASK_PROMPT,
    }),
  )
  yield* llm.pushMatch(
    reviewMatch,
    reply().text(REPORT).tool("finish", { result: "Needs fixes: one Important finding" }),
  )
  yield* llm.pushMatch(
    reviewMatch,
    reply().tool("finish", { result: REPORT }),
  )
  yield* llm.pushMatch(policyMatch, reply().text("Fixed the off-by-one in src/cache.ts."))
  yield* llm.pushMatch(noPolicyMatch, reply().text("I re-read the diff and the tests pass — the fix looks correct."))
})

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

it.instance(
  "default primary request surfaces the review delegation policy and the task tool describes the handoff",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "fix the off-by-one in the cache key")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")

      const hits = yield* llm.hits
      const parent = hits.find(policyMatch)
      expect(parent).toBeDefined()
      const body = bodyString(parent ?? { body: {} })
      expect(body).toContain("unit of work that changed files")
      expect(body).toContain("the recommended next step is review, not completion")
      expect(body).toContain("explicitly asks for a code review")
      expect(body).toContain("Review is guidance, not an enforcement gate")
      expect(body).toContain("call `finish` again to explicitly skip review")
      expect(body).toContain("does not apply to turns with no file changes")
      expect(body).toContain("background: false")
      expect(body).toContain("instruction to act, not an acknowledgment")
      expect(body).toContain("correct the record")
      expect(body).toContain("Review handoffs")
      expect(body).toContain("- review: Read-only code reviewer")
      expect(body).toContain("Use this proactively, without being asked")

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  15_000,
)

it.effect("gpt provider prompt routes review requests through the review subagent", () =>
  Effect.sync(function* () {
    const model = {
      api: { id: "gpt-5.1-mini" },
      providerID: ProviderV2.ID.make("test"),
    } as Parameters<typeof SystemPrompt.provider>[0]
    const prompt = SystemPrompt.provider(model).join("\n")
    expect(prompt).toContain("dispatch the read-only `review` subagent")
    expect(prompt).toContain("instead of reviewing the code yourself")
    expect(prompt).not.toContain("default to a code review mindset")
  }),
)

it.instance(
  "policy-following model delegates review and consumes the findings (default primary)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* scriptPolicyFollowingModel

      yield* user(chat.id, "fix the off-by-one in the cache key and add a test")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const policyHits = hits.filter(policyMatch)
      const reviewHits = hits.filter(reviewMatch)
      expect(reviewHits).toHaveLength(2)

      const reviewBody = bodyString(reviewHits[0])
      expect(reviewBody).toContain("Senior Code Reviewer")
      expect(reviewBody).not.toContain("## Review Loop")
      expect(reviewBody).toContain("uncommitted working tree")

      const reviewTools = toolNames(reviewHits[0])
      expect(reviewTools).toContain("finish")
      expect(reviewTools).toContain("read")
      expect(reviewTools).not.toContain("bash")
      expect(reviewTools).not.toContain("task")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskPart = msgs
        .flatMap((msg) => msg.parts)
        .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task")
      expect(taskPart?.state.status).toBe("completed")
      const completed = taskPart as CompletedToolPart
      expect(completed.state.metadata?.background).not.toBe(true)
      expect(completed.state.output).toContain("Needs fixes")
      const childID = completed.state.metadata?.sessionId
      expect(typeof childID).toBe("string")
      const child = yield* sessions.get(SessionID.make(childID as string))
      expect(child.agent).toBe("review")
      expect(child.parentID).toBe(chat.id)

      // This is the real Review runner path: the first finish call must be
      // rejected as recoverable tool feedback, and the same child session must
      // then complete through the retry.
      const childMessages = yield* MessageV2.filterCompactedEffect(child.id)
      const finishParts = childMessages
        .flatMap((msg) => msg.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
      expect(finishParts).toHaveLength(2)
      expect(finishParts.map((part) => part.state.status)).toEqual(["error", "completed"])
      if (finishParts[0]?.state.status === "error") {
        expect(finishParts[0].state.error).toContain("review result")
      }
      expect(finishParts[1]?.state.status).toBe("completed")

      expect(policyHits).toHaveLength(2)
      const followUp = bodyString(policyHits[1])
      expect(followUp).toContain("Needs fixes")
      expect(followUp).toContain("src/cache.ts:42")
      expect(followUp).toContain("instruction to act, not an acknowledgment")
    }),
  20_000,
)

it.instance(
  "same model does not delegate when the delegation policy is absent (non-default primary)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        agent: "custom",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* scriptPolicyFollowingModel

      yield* user(chat.id, "fix the off-by-one in the cache key and add a test", "custom")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const noPolicyHits = hits.filter(noPolicyMatch)
      expect(noPolicyHits).toHaveLength(1)
      expect(bodyString(noPolicyHits[0])).not.toContain("## Review Loop")
      expect(hits.filter(policyMatch)).toHaveLength(0)
      expect(hits.filter(reviewMatch)).toHaveLength(0)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(msgs.flatMap((msg) => msg.parts).some((part) => part.type === "tool" || part.type === "subtask")).toBe(
        false,
      )
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes("I re-read the diff and the tests pass")),
        ),
      ).toBe(true)
    }),
  20_000,
)

it.instance(
  "trivial conversational turn completes without review delegation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("Hello! What can I help you with?")
      yield* user(chat.id, "hi")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const parentHits = hits.filter(policyMatch)
      expect(parentHits).toHaveLength(1)
      const body = bodyString(parentHits[0] ?? { body: {} })
      expect(body).toContain("does not apply to turns with no file changes")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const parts = msgs.flatMap((msg) => msg.parts)
      expect(parts.some((part) => part.type === "tool")).toBe(false)
      expect(parts.some((part) => part.type === "subtask")).toBe(false)
      expect(
        parts.filter(
          (part): part is SessionV1.TextPart => part.type === "text" && "synthetic" in part && part.synthetic === true,
        ),
      ).toHaveLength(0)
    }),
  15_000,
)
