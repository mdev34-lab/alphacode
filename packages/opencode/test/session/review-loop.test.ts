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
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"

// ---------------------------------------------------------------------------
// Unit: pure loop-state derivation (no services)
// ---------------------------------------------------------------------------

const msg = (role: "user" | "assistant", parts: Array<Record<string, unknown>> = []) =>
  ({
    info: { role, ...(role === "user" ? {} : { finish: "tool-calls" }) },
    parts: parts.map((part, i) => ({ id: `p${i}`, ...part })),
  }) as unknown as SessionV1.WithParts

const tool = (name: string, state: Record<string, unknown>) => ({ type: "tool", tool: name, callID: name, state })
const completed = (input: Record<string, unknown> = {}, output = "") => ({
  status: "completed",
  input,
  output,
  title: "",
  metadata: {},
  time: { start: 0, end: 1 },
})
const writePart = () => tool("write", completed({ filePath: "a.ts" }))
const taskPart = (output: string, status: "completed" | "running" = "completed") =>
  status === "running"
    ? tool("task", { status, input: { subagent_type: "review" }, structured: {}, content: [] })
    : tool("task", completed({ subagent_type: "review" }, output))
const nudgeTextPart = () => ({ type: "text", synthetic: true, text: ReviewLoop.NUDGE_MARKER + " blocked" })
const realTextPart = (text: string) => ({ type: "text", text })

expect(ReviewLoop.parseVerdict("**Ready to proceed?** Approved")).toBe("approved")
expect(ReviewLoop.parseVerdict("**Ready to proceed?** Needs fixes")).toBe("needs-fixes")
expect(ReviewLoop.parseVerdict("Ready to proceed? needs-fixes")).toBe("needs-fixes")
expect(
  ReviewLoop.parseVerdict(
    "### Assessment\n**Ready to proceed?** Needs fixes\n**Reasoning:** an Important finding remains.",
  ),
).toBe("needs-fixes")
expect(ReviewLoop.parseVerdict("I did not use the report format at all")).toBe("unknown")
expect(ReviewLoop.parseVerdict("The plan was approved by the owner, not a code review")).toBe("unknown")

// The task slice begins after the last REAL user message: automated nudges
// (synthetic text) never reset the loop's memory.
{
  const msgs: SessionV1.WithParts[] = [
    msg("user", [realTextPart("do the work")]),
    msg("assistant", [writePart()]),
    msg("assistant", []),
    msg("user", [nudgeTextPart()]),
  ]
  const slice = ReviewLoop.taskSlice(msgs)
  expect(slice.length).toBe(3)
  const state = ReviewLoop.assess(msgs)
  expect(state.filesChanged).toBe(true)
  expect(state.dirty).toBe(true)
  expect(state.approved).toBe(false)

  const decision = ReviewLoop.decide(msgs, { cap: 5, nudges: 0 })
  expect(decision.inLoop).toBe(true)
  expect(decision.blocked).toBe(true)
  expect(decision.phase).toBe("work")
}

// Approved verdict clears the gate; a later change re-dirties it.
{
  const report = "**Ready to proceed?** Approved"
  const approved: SessionV1.WithParts[] = [
    msg("user", [realTextPart("work")]),
    msg("assistant", [writePart(), taskPart(report)]),
  ]
  expect(ReviewLoop.assess(approved).approved).toBe(true)
  expect(ReviewLoop.decide(approved, { cap: 5, nudges: 0 }).blocked).toBe(false)
  expect(ReviewLoop.decide(approved, { cap: 5, nudges: 0 }).exitReason).toBe("approved")

  const redirtied: SessionV1.WithParts[] = [
    ...approved,
    msg("assistant", [tool("edit", completed({ filePath: "a.ts" }))]),
  ]
  const state = ReviewLoop.assess(redirtied)
  expect(state.approved).toBe(false)
  expect(state.dirty).toBe(true)
}

// Findings reported → still dirty → blocked; a cap reached → released.
{
  const findings = "**Ready to proceed?** Needs fixes"
  const msgs: SessionV1.WithParts[] = [
    msg("user", [realTextPart("work")]),
    msg("assistant", [writePart(), taskPart(findings)]),
  ]
  expect(ReviewLoop.decide(msgs, { cap: 1, nudges: 0 }).blocked).toBe(false)
  expect(ReviewLoop.decide(msgs, { cap: 1, nudges: 0 }).exitReason).toBe("cap")
  expect(ReviewLoop.decide(msgs, { cap: 2, nudges: 2 }).blocked).toBe(false)
  // Nudges alone reach the cap when the model never dispatches a review.
  const stubborn: SessionV1.WithParts[] = [msg("user", [realTextPart("work")]), msg("assistant", [writePart()])]
  expect(ReviewLoop.decide(stubborn, { cap: 2, nudges: 2 }).blocked).toBe(false)
  expect(ReviewLoop.decide(stubborn, { cap: 2, nudges: 2 }).exitReason).toBe("cap")
  const stillBlocking = ReviewLoop.decide(stubborn, { cap: 3, nudges: 2 })
  expect(stillBlocking.blocked).toBe(true)
  // No exit reason while the loop is still holding the task.
  expect(stillBlocking.exitReason).toBeUndefined()
}

// A running review flips the phase to "review"; errors keep the unit dirty.
{
  const msgs: SessionV1.WithParts[] = [
    msg("user", [realTextPart("work")]),
    msg("assistant", [writePart(), taskPart("", "running")]),
  ]
  const decision = ReviewLoop.decide(msgs, { cap: 5, nudges: 0 })
  expect(decision.phase).toBe("review")
  expect(decision.inLoop).toBe(true)

  const errored: SessionV1.WithParts[] = [
    msg("user", [realTextPart("work")]),
    msg("assistant", [
      writePart(),
      tool("task", {
        status: "error",
        input: { subagent_type: "review" },
        error: "boom",
        content: {},
        time: { start: 0, end: 1 },
      }),
    ]),
  ]
  expect(ReviewLoop.assess(errored).dirty).toBe(true)
}

const mk = (...outputs: string[]) => [
  msg("user", [realTextPart("work")]),
  ...outputs.map((output) => msg("assistant", [writePart(), taskPart(output)])),
]

// The stall guard releases only on identical blocking findings across
// consecutive reviews; new findings reset the streak, so long productive
// loops are never punished.
{
  const findingsA = "#### Important (Should Fix)\n- src/a.ts:1: missing null check\n\n**Ready to proceed?** Needs fixes"
  const findingsB =
    "#### Important (Should Fix)\n- src/b.ts:9: wrong retry backoff\n\n**Ready to proceed?** Needs fixes"
  expect(ReviewLoop.severityFindings("no sections here")).toBeUndefined()
  const repeated = ReviewLoop.decide(mk(findingsA, findingsA, findingsA), { nudges: 0 })
  expect(repeated.stalled).toBe(true)
  expect(repeated.blocked).toBe(false)
  expect(repeated.exitReason).toBe("stalled")
  const progressing = ReviewLoop.decide(mk(findingsA, findingsB, findingsA), { nudges: 0 })
  expect(progressing.stalled).toBe(false)
  expect(progressing.blocked).toBe(true)
  expect(progressing.exitReason).toBeUndefined()
  // A long, still-changing loop is never released: 25 rounds of alternating
  // findings stay blocked with no cap configured.
  const marathon = mk(...Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? findingsA : findingsB)))
  const long = ReviewLoop.decide(marathon, { nudges: 25 })
  expect(long.blocked).toBe(true)
  expect(long.exitReason).toBeUndefined()
  expect(long.stalled).toBe(false)
}

// The unresponsive backstop releases a loop the model is ignoring, while a
// loop that dispatches reviews keeps nudges in step and never trips it.
{
  const ignored: SessionV1.WithParts[] = [msg("user", [realTextPart("work")]), msg("assistant", [writePart()])]
  expect(ReviewLoop.decide(ignored, { nudges: 4 }).blocked).toBe(true)
  const released = ReviewLoop.decide(ignored, { nudges: 5 })
  expect(released.blocked).toBe(false)
  expect(released.exitReason).toBe("unresponsive")
  expect(ReviewLoop.exitNoteText(released)).toContain(ReviewLoop.UNRESPONSIVE_MARKER)
  const responsive = mk(
    "#### Important (Should Fix)\n- a.ts:1 x\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- b.ts:2 y\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- c.ts:3 z\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- d.ts:4 w\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- e.ts:5 v\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- f.ts:6 u\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- g.ts:7 t\n\n**Ready to proceed?** Needs fixes",
    "#### Important (Should Fix)\n- h.ts:8 s\n\n**Ready to proceed?** Needs fixes",
  )
  // 8 review passes, 7 nudges: nudges stay below passes + 5 → never unresponsive.
  expect(ReviewLoop.decide(responsive, { nudges: 7 }).blocked).toBe(true)
}

// Turns with no file changes never enter the loop.
{
  const msgs: SessionV1.WithParts[] = [msg("user", [realTextPart("what is 2+2?")]), msg("assistant", [])]
  expect(ReviewLoop.decide(msgs, { cap: 5, nudges: 0 }).inLoop).toBe(false)
}

// The nudge text carries the counters and the actionable contract.
{
  const msgs: SessionV1.WithParts[] = [msg("user", [realTextPart("work")]), msg("assistant", [writePart()])]
  const text = ReviewLoop.nudgeText(ReviewLoop.decide(msgs, { cap: 5, nudges: 1 }))
  expect(text).toContain(ReviewLoop.NUDGE_MARKER)
  expect(text).toContain("1 of 5 review passes used")
  expect(text).toContain("the configured cap of 5 passes")
  expect(text).toContain('subagent_type: "review"')
  expect(text).toContain("No review has been dispatched")
  expect(text).not.toContain("{pending}")
  expect(text).not.toContain("{progress}")
  expect(text).not.toContain("{release}")
  // Unconfigured cap (the default): no round-limit language at all.
  const uncapped = ReviewLoop.nudgeText(ReviewLoop.decide(msgs, { nudges: 1 }))
  expect(uncapped).toContain("no round limit")
  expect(uncapped).not.toContain("configured cap")
}

// ---------------------------------------------------------------------------
// Integration: the driver refuses task exits until review approves, and
// releases them at the configured cap.
// ---------------------------------------------------------------------------

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
    startAuth: () => Effect.die("unexpected MCP auth in review-loop tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-loop tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-loop tests"),
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

// The primary agent keeps the finish tool: the driver only releases a task
// when finish completes, so the gate can hook the sanctioned exit path.
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
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(
      path.join(dir, "opencode.json"),
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
const policyMatch = (hit: { body: unknown }) => {
  const body = bodyString(hit)
  return body.includes("Mandatory Review Loop") && !body.includes("Senior Code Reviewer")
}
const reviewMatch = (hit: { body: unknown }) => bodyString(hit).includes("Senior Code Reviewer")

const FINDINGS_REPORT = [
  "### Spec Compliance",
  "- ❌ Issues found: the test for the off-by-one is missing (src/cache.test.ts)",
  "",
  "#### Important (Should Fix)",
  "- src/cache.test.ts: no test covers the corrected boundary",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
].join("\n")

const APPROVED_REPORT = [
  "### Spec Compliance",
  "- ✅ Spec compliant",
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

const nudgeCount = (msgs: readonly SessionV1.WithParts[]) =>
  msgs.flatMap((m) => m.parts).filter((part) => part.type === "text" && part.text.startsWith(ReviewLoop.NUDGE_MARKER))
    .length

const reviewTaskParts = (msgs: readonly SessionV1.WithParts[]) =>
  msgs
    .flatMap((m) => m.parts)
    .filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "task" &&
        part.state.status !== "pending" &&
        part.state.input.subagent_type === "review",
    )

it.instance(
  "task exit is refused until the reviewer approves, then released (work ↔ review cycles)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Loop",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // 1: work pass changes a file.
      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      // 2: premature finish — must be blocked by the gate.
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "fixed, all done" }))
      // 3: after the nudge, dispatch the reviewer synchronously.
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review the cache fix\nDiff: @@ -1 +1 @@")))
      // reviewer pass 1: findings.
      yield* llm.pushMatch(
        reviewMatch,
        reply().text(FINDINGS_REPORT).tool("finish", { result: "Needs fixes: test missing" }),
      )
      // 4: finish again without addressing the finding — still blocked.
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "done now" }))
      // 5: address the finding, then finish (dirty again → blocked once more).
      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.test.ts", content: "test\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "added test" }))
      // 6: re-review of the fixes; reviewer approves.
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("re-review only the fix diff")))
      yield* llm.pushMatch(reviewMatch, reply().text(APPROVED_REPORT).tool("finish", { result: "Approved" }))
      // 7: finish finally clears the gate.
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "complete after review approval" }))

      yield* user(chat.id, "fix the off-by-one in the cache key and add a test")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      // Two full review iterations ran: findings → fix → re-review → approval.
      expect(reviewTaskParts(msgs)).toHaveLength(2)
      // Three blocked exits were nudged: before any review, on unresolved
      // findings, and after the fix before the re-review.
      expect(nudgeCount(msgs)).toBe(3)
      // The approved turn ends normally, and the loop was NOT a cap exit.
      const texts = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text")
      expect(texts.some((p) => p.type === "text" && p.text.startsWith(ReviewLoop.CAP_MARKER))).toBe(false)
      const finishes = msgs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool" && p.tool === "finish" && p.state.status === "completed")
      expect(finishes).toHaveLength(4) // three blocked, one clearing the gate
    }),
  30_000,
)

it.instance(
  "loop releases on the configured cap and notes the reason in the transcript",
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
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "first attempt" }))
      // review pass 1 → findings → the gate still has room (cap is 2):
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review attempt")))
      yield* llm.pushMatch(reviewMatch, reply().text(FINDINGS_REPORT).tool("finish", { result: "Needs fixes" }))
      // model tries to finish → second nudge now reaches the cap…
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "second attempt" }))
      // …so this finish must be released with the cap reason, not nudged.
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "delivering with one open finding" }))

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(reviewTaskParts(msgs)).toHaveLength(1)
      expect(nudgeCount(msgs)).toBe(2)
      const capNotes = msgs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.text.startsWith(ReviewLoop.CAP_MARKER))
      expect(capNotes).toHaveLength(1)
      const texts = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text")
      expect(
        texts.some(
          (p) =>
            p.type === "text" &&
            p.text.includes("Review loop ended on the configured iteration cap after 1 review pass"),
        ),
      ).toBe(true)
    }),
  30_000,
)

it.instance(
  "stalled loop releases without approval and notes the reason; no cap note",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({ stall_limit: 2 })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stall",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Two review passes report the exact same Important finding; the second
      // one makes the loop stalled, so the next finish is released even though
      // the runaway cap (default 25) is nowhere near.
      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "fix\n" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "first attempt" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review attempt 1")))
      yield* llm.pushMatch(reviewMatch, reply().text(FINDINGS_REPORT).tool("finish", { result: "Needs fixes" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "second attempt" }))
      yield* llm.pushMatch(policyMatch, reply().tool("task", reviewDispatch("review attempt 2")))
      yield* llm.pushMatch(reviewMatch, reply().text(FINDINGS_REPORT).tool("finish", { result: "Needs fixes again" }))
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "adjudicating the stalled finding" }))

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(reviewTaskParts(msgs)).toHaveLength(2)
      // Only the two pre-stall exits were nudged; the stalled one was released.
      expect(nudgeCount(msgs)).toBe(2)
      const stallNotes = msgs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.text.startsWith(ReviewLoop.STALL_MARKER))
      expect(stallNotes).toHaveLength(1)
      const capNotes = msgs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.text.startsWith(ReviewLoop.CAP_MARKER))
      expect(capNotes).toHaveLength(0)
    }),
  30_000,
)

it.instance(
  "a model that ignores every reminder is released by the backstop, not a round cap",
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

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      // Five reminders were injected; the sixth finish iteration is released by
      // the unresponsiveness backstop — no review was ever dispatched, so no
      // round-count cap is what stopped this loop.
      expect(reviewTaskParts(msgs)).toHaveLength(0)
      expect(nudgeCount(msgs)).toBe(5)
      const notes = msgs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.text.startsWith(ReviewLoop.UNRESPONSIVE_MARKER))
      expect(notes).toHaveLength(1)
    }),
  30_000,
)

it.instance(
  "gate is configurable off: with review_loop.enabled=false the task finishes unreviewed",
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
      yield* llm.pushMatch(policyMatch, reply().tool("finish", { result: "done without review" }))

      yield* user(chat.id, "fix the cache key")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      expect(hits.filter(reviewMatch)).toHaveLength(0)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(nudgeCount(msgs)).toBe(0)
    }),
  30_000,
)

it.instance(
  "conversational turns without file changes are never gated",
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
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(nudgeCount(msgs)).toBe(0)
    }),
  30_000,
)

it.instance(
  "statusline: the driver publishes the review status while the loop is active",
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

      // request #1 completes a write; request #2 hangs so the loop parks at
      // the next iteration top — where the gate is open and the status must
      // report the loop.
      yield* llm.pushMatch(policyMatch, reply().tool("write", { filePath: "src/cache.ts", content: "x\n" }))
      yield* llm.hang
      yield* user(chat.id, "fix the cache")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(2), "timed out waiting for both model requests", "10 seconds")
      const observed = yield* awaitWithTimeout(
        Effect.gen(function* () {
          for (;;) {
            const s = yield* status.get(chat.id)
            if (s.type === "review") return s
            yield* Effect.sleep("50 millis")
          }
        }),
        "timed out waiting for review status",
        "10 seconds",
      )
      expect(observed.phase).toBe("work")
      // No round cap by default: the status reports 0 ("uncapped").
      expect(observed.cap).toBe(0)
      expect(observed.iteration).toBe(1)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  30_000,
)
