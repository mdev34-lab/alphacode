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
// agents opt out so trivial-turn tests can end with a plain reply.
const cfg = {
  agent: {
    work: { finishTool: false },
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

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "work",
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

// Requests the default primary agent makes carry the review loop; reviewer
// requests carry the reviewer prompt instead. Title requests are auto-answered
// by the test server and never reach these matchers.
const parentMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("Mandatory Review Loop") && !body.includes("Senior Code Reviewer")
}

const reviewMatch = (hit: { body: unknown }) => bodyString(hit).includes("Senior Code Reviewer")

// The reviewer's report, distinctive enough to trace into the parent's next
// model request.
const REPORT = [
  "### Spec Compliance",
  "- ❌ Issues found: cache key drops the tenant prefix (src/cache.ts:42)",
  "",
  "#### Important (Should Fix)",
  "- src/cache.ts:42: off-by-one skips the first cache entry; the loop must start at 0",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
].join("\n")

const TASK_PROMPT = [
  "What was requested: fix the off-by-one in the cache key and add a test.",
  "What changed: src/cache.ts, src/cache.test.ts",
  "Boundary: uncommitted working tree, expected files src/cache.ts and src/cache.test.ts",
  "Diff: @@ -41,7 +41,7 @@ for (let i = 1; i <= entries.length; i++) {",
].join("\n")

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

// Prompt-level coverage: the delegation policy must reach the model on every
// turn of the default primary agent, and the task tool must describe the review
// handoff and list the review agent as proactive.
it.instance(
  "default primary prompt carries the review delegation policy and the task tool describes the handoff",
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
      const parent = hits.find(parentMatch)
      expect(parent).toBeDefined()
      const body = bodyString(parent ?? { body: {} })

      // The trigger: units of work that changed files, the verification stage,
      // and explicit user review requests.
      expect(body).toContain("unit of work that changed files")
      expect(body).toContain("the next step is review, not completion")
      expect(body).toContain("explicitly asks for a code review")

      // The carve-out: trivial turns with no file changes must not be reviewed.
      expect(body).toContain("does not apply to turns with no file changes")

      // The handoff is synchronous so the verdict lands before completion is
      // claimed.
      expect(body).toContain("background: false")

      // Findings must be consumed, including reports that arrive late.
      expect(body).toContain("instruction to act, not an acknowledgment")
      expect(body).toContain("correct the record")

      // The task tool teaches the review handoff and lists the review agent in
      // its roster with proactive-use wording.
      expect(body).toContain("Review handoffs")
      expect(body).toContain("- review: Read-only code reviewer")
      expect(body).toContain("Use this proactively, without being asked")

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  15_000,
)

// Provider prompts must route explicit review requests to the review subagent
// instead of telling the model to review the code itself.
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

// End-to-end wiring: after a non-trivial unit the main agent dispatches
// `review`, the reviewer runs with its own read-only prompt (and no review loop
// of its own — no recursion), and its findings land in the parent's next model
// request next to the instructions for acting on them.
it.instance(
  "review delegation runs the reviewer and returns its findings to the main agent",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // 1. The main agent finishes implementing and dispatches the reviewer
      //    synchronously, carrying the evidence the read-only reviewer needs.
      yield* llm.pushMatch(
        parentMatch,
        reply().tool("task", {
          description: "Review cache fix",
          subagent_type: "review",
          background: false,
          prompt: TASK_PROMPT,
        }),
      )
      // 2. The reviewer reports findings and ends its turn through the finish
      //    tool.
      yield* llm.pushMatch(
        reviewMatch,
        reply().text(REPORT).tool("finish", { result: "Needs fixes: one Important finding" }),
      )
      // 3. The main agent consumes the report in its next turn.
      yield* llm.pushMatch(parentMatch, reply().text("Fixed the off-by-one in src/cache.ts."))

      yield* user(chat.id, "fix the off-by-one in the cache key and add a test")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const parentHits = hits.filter(parentMatch)
      const reviewHits = hits.filter(reviewMatch)
      expect(reviewHits).toHaveLength(1)

      // The reviewer ran with its own prompt — and no review loop of its own,
      // so reviews cannot recurse.
      const reviewBody = bodyString(reviewHits[0])
      expect(reviewBody).toContain("Senior Code Reviewer")
      expect(reviewBody).not.toContain("Mandatory Review Loop")
      expect(reviewBody).toContain("uncommitted working tree")

      // The reviewer keeps its read-only toolset but still gets the finish
      // tool: without it a deny-by-default subagent can never end its turn,
      // and the dispatch wedges in finish nudges instead of returning a
      // verdict.
      const reviewTools = toolNames(reviewHits[0])
      expect(reviewTools).toContain("finish")
      expect(reviewTools).toContain("read")
      expect(reviewTools).not.toContain("bash")
      expect(reviewTools).not.toContain("task")

      // The dispatch created a synchronous review-agent child session.
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

      // The findings were consumed: the parent's follow-up request contains
      // the report and the instructions to act on it.
      expect(parentHits).toHaveLength(2)
      const followUp = bodyString(parentHits[1])
      expect(followUp).toContain("Needs fixes")
      expect(followUp).toContain("src/cache.ts:42")
      expect(followUp).toContain("instruction to act, not an acknowledgment")
    }),
  20_000,
)

// Trivial conversational turn: the carve-out reaches the model, nothing
// dispatches a reviewer, and the turn completes normally without synthetic
// review injections.
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
      const parentHits = hits.filter(parentMatch)
      expect(parentHits).toHaveLength(1)

      // The carve-out instruction reached the model on this trivial turn.
      const body = bodyString(parentHits[0] ?? { body: {} })
      expect(body).toContain("does not apply to turns with no file changes")

      // Nothing dispatched a reviewer and no review nudge was injected: the
      // only parts are the user's greeting and the assistant's reply.
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const parts = msgs.flatMap((msg) => msg.parts)
      expect(parts.some((part) => part.type === "tool")).toBe(false)
      expect(parts.some((part) => part.type === "subtask")).toBe(false)
      expect(
        parts.filter(
          (part): part is SessionV1.TextPart =>
            part.type === "text" && "synthetic" in part && part.synthetic === true,
        ),
      ).toHaveLength(0)
    }),
  15_000,
)
