import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
import { ReviewStagnation } from "../../src/session/review-stagnation"
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
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"

// ---------------------------------------------------------------------------
// Pure evaluator coverage: the literal-repeat state machine.
// ---------------------------------------------------------------------------

const A = "Review completed for the uncommitted PDF update. Verdict: Needs fixes due to missing tests."
const B = "Review completed for the uncommitted PDF update. Verdict: Approved."
const C = "Review completed for the uncommitted PDF update. Verdict: Needs fixes due to a typo."

type Message = ReviewStagnation.ReviewStagnationMessage
type Part = ReviewStagnation.ReviewStagnationPart

function userMsg(text: string, synthetic = false): Message {
  return { info: { role: "user" }, parts: [{ type: "text", text, synthetic }] }
}

function nudgeMsg(text = "Continue."): Message {
  return userMsg(text, true)
}

function reviewMsg(text: string, extra: Part[] = []): Message {
  return { info: { role: "assistant" }, parts: [{ type: "text", text }, ...extra] }
}

function textsMsg(parts: Part[]): Message {
  return { info: { role: "assistant" }, parts }
}

function toolMsg(tool: string, status: string): Message {
  return {
    info: { role: "assistant" },
    parts: [{ type: "tool", tool, state: { status } }],
  }
}

describe("ReviewStagnation.resolveRepeats", () => {
  test("defaults to two consecutive identical outputs", () => {
    expect(ReviewStagnation.resolveRepeats({})).toBe(2)
    expect(ReviewStagnation.DEFAULT_REPEATS).toBe(2)
  })

  test("overrides win and 0 is preserved for disabling", () => {
    expect(ReviewStagnation.resolveRepeats({ repeats: 2 })).toBe(2)
    expect(ReviewStagnation.resolveRepeats({ repeats: 0 })).toBe(0)
  })
})

describe("ReviewStagnation.normalizeReviewOutput", () => {
  test("normalizes line-ending bytes only", () => {
    expect(ReviewStagnation.normalizeReviewOutput("one\ntwo")).toBe("one\ntwo")
    expect(ReviewStagnation.normalizeReviewOutput("one\r\ntwo")).toBe("one\ntwo")
    expect(ReviewStagnation.normalizeReviewOutput("one\rtwo")).toBe("one\ntwo")
    // Nothing else is touched: case, punctuation, and whitespace survive.
    expect(ReviewStagnation.normalizeReviewOutput("  Verdict: OK.  ")).toBe("  Verdict: OK.  ")
  })
})

describe("ReviewStagnation.reviewStagnationState", () => {
  const cases: {
    name: string
    messages: Message[]
    repeats?: number
    want: { repeats: number; stagnated: boolean }
  }[] = [
    {
      name: "empty history never stagnates",
      messages: [],
      want: { repeats: 0, stagnated: false },
    },
    {
      name: "a single review is not repetition",
      messages: [userMsg("review this"), reviewMsg(A)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "two identical outputs cross the default threshold",
      messages: [userMsg("review this"), reviewMsg(A), nudgeMsg(), reviewMsg(A)],
      want: { repeats: 2, stagnated: true },
    },
    {
      name: "two identical outputs stay below a higher threshold",
      messages: [userMsg("review this"), reviewMsg(A), nudgeMsg(), reviewMsg(A)],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "three identical outputs trigger recovery",
      messages: [userMsg("review this"), reviewMsg(A), nudgeMsg(), reviewMsg(A), nudgeMsg(), reviewMsg(A)],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "further identical outputs keep the heuristic triggered",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(A), reviewMsg(A)],
      want: { repeats: 4, stagnated: true },
    },
    {
      name: "A → A → B → B does not carry A toward B",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(B), reviewMsg(B)],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "any different output resets the run",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(B)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "distinct outputs never trigger",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(B), reviewMsg(C)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "a completed read between repeats breaks the run",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        toolMsg("read", "completed"),
        reviewMsg(A),
        reviewMsg(A),
      ],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "a failed tool call between repeats breaks the run",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        toolMsg("read", "error"),
        reviewMsg(A),
        reviewMsg(A),
      ],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "a rejected finish between repeats breaks the run",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        toolMsg("finish", "error"),
        reviewMsg(A),
        reviewMsg(A),
      ],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "text plus a tool call in one generation is progress, not a restatement",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A, [{ type: "tool", tool: "read", state: { status: "completed" } }]),
        reviewMsg(A),
      ],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "a completed finish is terminal, never stagnated",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(A), toolMsg("finish", "completed")],
      want: { repeats: 0, stagnated: false },
    },
    {
      name: "repeats after a completed finish are still terminal",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        toolMsg("finish", "completed"),
        reviewMsg(A),
        reviewMsg(A),
        reviewMsg(A),
      ],
      want: { repeats: 0, stagnated: false },
    },
    {
      name: "synthetic continuation nudges are skipped, not progress",
      messages: [userMsg("review this"), reviewMsg(A), nudgeMsg(), reviewMsg(A), nudgeMsg(), reviewMsg(A)],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "a new real user message starts a fresh turn",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), userMsg("also check the tests"), reviewMsg(A)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "history before the current turn is ignored",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        reviewMsg(A),
        userMsg("review that fix"),
        reviewMsg(B),
      ],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "line-ending differences still compare equal",
      messages: [userMsg("review this"), reviewMsg("one\ntwo"), reviewMsg("one\r\ntwo"), reviewMsg("one\rtwo")],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "a trailing space is a meaningful difference",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(`${A} `)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "a trailing newline is a meaningful difference",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(`${A}\n`)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "case is a meaningful difference",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A.toLowerCase())],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "interior whitespace is a meaningful difference",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A.replace("Needs fixes", "Needs  fixes"))],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "punctuation is a meaningful difference",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A.replace(/\.$/, ""))],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "trailing empty text parts are structural, not content",
      messages: [
        userMsg("review this"),
        textsMsg([{ type: "text", text: A }]),
        textsMsg([
          { type: "text", text: A },
          { type: "text", text: "" },
        ]),
        textsMsg([{ type: "text", text: A }]),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "reasoning differences do not break a text run",
      messages: [
        userMsg("review this"),
        reviewMsg(A, [{ type: "reasoning", text: "first pass" }]),
        reviewMsg(A, [{ type: "reasoning", text: "second pass, different words" }]),
        reviewMsg(A),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "step markers do not break a text run",
      messages: [userMsg("review this"), reviewMsg(A, [{ type: "step-start" }, { type: "step-finish" }]), reviewMsg(A)],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "synthetic text parts are harness input, not model output",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        textsMsg([
          { type: "text", text: "injected context", synthetic: true },
          { type: "text", text: A },
        ]),
        reviewMsg(A),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "ignored text parts are excluded like the model-message projection",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        textsMsg([
          { type: "text", text: "stale context", ignored: true },
          { type: "text", text: A },
        ]),
        reviewMsg(A),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "whitespace-only generations reset the run",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg("  \n  "), reviewMsg(A), reviewMsg(A)],
      repeats: 3,
      want: { repeats: 2, stagnated: false },
    },
    {
      name: "empty generations reset the run",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), textsMsg([]), reviewMsg(A)],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "an errored assistant resets the run",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        { info: { role: "assistant", error: { name: "UnknownError" } }, parts: [{ type: "text", text: A }] },
        reviewMsg(A),
      ],
      want: { repeats: 1, stagnated: false },
    },
    {
      name: "compaction summaries are skipped, not generations",
      messages: [
        userMsg("review this"),
        reviewMsg(A),
        reviewMsg(A),
        { info: { role: "assistant", summary: true }, parts: [{ type: "text", text: "summary of the turn" }] },
        reviewMsg(A),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "multiple text parts join before comparison",
      messages: [
        userMsg("review this"),
        textsMsg([
          { type: "text", text: "head" },
          { type: "text", text: "tail" },
        ]),
        textsMsg([
          { type: "text", text: "head" },
          { type: "text", text: "tail" },
        ]),
        textsMsg([
          { type: "text", text: "head" },
          { type: "text", text: "tail" },
        ]),
      ],
      want: { repeats: 3, stagnated: true },
    },
    {
      name: "a tighter threshold triggers earlier",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A)],
      repeats: 2,
      want: { repeats: 2, stagnated: true },
    },
    {
      name: "a threshold of 1 disables the heuristic",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(A)],
      repeats: 1,
      want: { repeats: 3, stagnated: false },
    },
    {
      name: "a threshold of 0 disables the heuristic",
      messages: [userMsg("review this"), reviewMsg(A), reviewMsg(A), reviewMsg(A)],
      repeats: 0,
      want: { repeats: 3, stagnated: false },
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(ReviewStagnation.reviewStagnationState(c.messages, c.repeats)).toEqual(c.want)
    })
  }
})

// ---------------------------------------------------------------------------
// Prompt contract: the recovery nudge.
// ---------------------------------------------------------------------------

const promptDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")

describe("review stagnation nudge contract", () => {
  test("the recovery nudge directs the model into the existing finish path", async () => {
    const nudge = await readFile(path.join(promptDirectory, "review-stagnation-nudge.txt"), "utf8")

    expect(nudge).toContain("repeated the same completed review without making progress")
    expect(nudge).toContain("call `finish` now with the findings already established")
    // Review finish calls without the envelope are rejected, so the recovery
    // names the requirement instead of inviting another rejected call.
    expect(nudge).toContain("<alphacode-review>")
    expect(nudge).toContain("Do not answer it conversationally")
    // Provider-neutral by construction: no model or provider is named.
    expect(nudge).not.toContain("Nex")
  })

  test("the generic finish nudge stays distinct from the recovery nudge", async () => {
    const generic = await readFile(path.join(promptDirectory, "finish-nudge.txt"), "utf8")
    const recovery = await readFile(path.join(promptDirectory, "review-stagnation-nudge.txt"), "utf8")

    expect(generic).toContain("The turn ended without a successful finish call")
    expect(generic).not.toContain("repeated the same completed review")
    expect(recovery).not.toBe(generic)
  })
})

// ---------------------------------------------------------------------------
// Hard backstop: completing a review the model will not finish itself (#176).
// ---------------------------------------------------------------------------

const recoveryNudge = await readFile(path.join(promptDirectory, "review-stagnation-nudge.txt"), "utf8")

const DONE = "Review completed for the uncommitted PDF update. Verdict: Needs fixes due to missing tests."

function envelope(assessment: "approved" | "needs-fixes", summary: string) {
  return [
    `Assessment: ${assessment === "approved" ? "Approved" : "Needs fixes"}`,
    "",
    "<alphacode-review>",
    JSON.stringify({ version: 1, revision: "uncommitted", assessment, summary, findings: [] }, null, 2),
    "</alphacode-review>",
  ].join("\n")
}

const NEEDS_FIXES = envelope("needs-fixes", "The PDF update misses edge-case tests.")
const APPROVED = envelope("approved", "A later pass clears the update.")

describe("ReviewStagnation.reviewStagnationBackstop", () => {
  const cases: {
    name: string
    messages: Message[]
    repeats?: number
    want?: { assessment: "approved" | "needs-fixes"; summary: string }
  }[] = [
    {
      name: "completes from the report the turn already established",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(),
        reviewMsg(DONE),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
        reviewMsg(DONE),
      ],
      want: { assessment: "needs-fixes", summary: "The PDF update misses edge-case tests." },
    },
    {
      name: "the repeated output itself may be the report",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(recoveryNudge),
        reviewMsg(NEEDS_FIXES),
      ],
      want: { assessment: "needs-fixes", summary: "The PDF update misses edge-case tests." },
    },
    {
      name: "the last report the turn established wins",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        reviewMsg(APPROVED),
        reviewMsg(DONE),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
      ],
      want: { assessment: "approved", summary: "A later pass clears the update." },
    },
    {
      name: "no report means no backstop, however long the run",
      messages: [
        userMsg("review this"),
        reviewMsg(DONE),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
        reviewMsg(DONE),
        reviewMsg(DONE),
      ],
    },
    {
      // The nudge belongs to the run it was sent into. The model answered it
      // with a tool call, so the identical run that follows is a fresh one and
      // cannot inherit it: progress after a nudge spends that nudge.
      name: "progress after a recovery nudge spends it for the next run",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(recoveryNudge),
        toolMsg("read", "completed"),
        reviewMsg(DONE),
        reviewMsg(DONE),
      ],
    },
    {
      // "Other progress" spends a nudge the same way: a different generation
      // ends the run it was sent into, so the identical run that follows is a
      // fresh one and owns its own nudge.
      name: "a different generation starts a run that owns its own nudge",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(recoveryNudge),
        reviewMsg(APPROVED),
        reviewMsg(APPROVED),
      ],
    },
    {
      // The other half of the boundary: the same turn completes as soon as the
      // fresh run is nudged itself.
      name: "a fresh run completes once it earns its own recovery nudge",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(recoveryNudge),
        toolMsg("read", "completed"),
        reviewMsg(DONE),
        reviewMsg(DONE),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
      ],
      want: { assessment: "needs-fixes", summary: "The PDF update misses edge-case tests." },
    },
    {
      name: "a run shorter than the threshold never completes a review",
      messages: [userMsg("review this"), reviewMsg(NEEDS_FIXES), nudgeMsg(recoveryNudge), reviewMsg(DONE)],
    },
    {
      name: "a real user message that repeats the nudge wording is not the nudge",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        userMsg(recoveryNudge),
        reviewMsg(DONE),
        reviewMsg(DONE),
      ],
    },
    {
      name: "a completed finish ends the turn",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
        toolMsg("finish", "completed"),
        reviewMsg(DONE),
        reviewMsg(DONE),
      ],
    },
    {
      name: "a threshold of 1 disables the backstop",
      messages: [
        userMsg("review this"),
        reviewMsg(NEEDS_FIXES),
        reviewMsg(DONE),
        nudgeMsg(recoveryNudge),
        reviewMsg(DONE),
      ],
      repeats: 1,
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      const backstop = ReviewStagnation.reviewStagnationBackstop({
        messages: c.messages,
        repeats: c.repeats,
        recoveryNudge,
      })
      if (!c.want) {
        expect(backstop).toBeUndefined()
        return
      }
      expect(backstop?.report.revision).toBe("uncommitted")
      expect(backstop?.report.assessment).toBe(c.want.assessment)
      // The completion reuses the established report verbatim: its summary,
      // its findings, and one canonical envelope.
      expect(backstop?.result).toContain(c.want.summary)
      expect(backstop?.result).toContain("<alphacode-review>")
    })
  }
})

// ---------------------------------------------------------------------------
// Loop integration: the minimal dispatch seam.
//
// The exhaustive behavior matrices live in the pure tests above. These tests
// only prove the real `SessionPrompt` loop consults them: a stagnated review
// earns the recovery nudge and can still finish normally, a review that
// ignores the nudge is completed from the report it already delivered, a
// stagnated review without a report keeps the existing finish gate, and
// identical repeats from any other agent keep the generic reminder.
// ---------------------------------------------------------------------------

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
    startAuth: () => Effect.die("unexpected MCP auth in review-stagnation tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review-stagnation tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review-stagnation tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

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

function compileRoot(flagOverrides: Parameters<typeof RuntimeFlags.layer>[0]) {
  return LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer(flagOverrides)],
  ])
}

const it = testEffect(compileRoot({ experimentalEventSystem: true }))

// Finish stays enabled for `review` and `work` so the nudge paths exercised
// here match production (agents end their turn through the finish tool).
const cfg = {
  agent: {
    work: { finishTool: true },
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

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string, agent = "review") {
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

const TASK_PROMPT = [
  "What was requested: update the PDF export and add a test.",
  "What changed: src/pdf.ts, src/pdf.test.ts",
  "Boundary: uncommitted working tree, expected files src/pdf.ts and src/pdf.test.ts",
  "Diff: @@ -41,7 +41,7 @@ for (let i = 1; i <= entries.length; i++) {",
].join("\n")

function report(assessment: "approved" | "needs-fixes", summary: string) {
  return [
    "### Spec Compliance",
    assessment === "approved" ? "- ✅ Spec compliant" : "- ❌ Issues found: edge cases untested (src/pdf.ts:42)",
    "",
    "### Assessment",
    `Assessment: ${assessment === "approved" ? "Approved" : "Needs fixes"}`,
    "",
    "<alphacode-review>",
    JSON.stringify(
      {
        version: 1,
        revision: "uncommitted",
        assessment,
        summary,
        findings:
          assessment === "approved"
            ? []
            : [
                {
                  severity: "important",
                  title: "Edge cases untested",
                  file: "src/pdf.ts",
                  line: 42,
                  detail: "Add the missing tests.",
                },
              ],
      },
      null,
      2,
    ),
    "</alphacode-review>",
  ].join("\n")
}

// The issue #171 symptom: the same completed review text, reproduced
// verbatim across generations instead of a finish call.
const REPEAT = report("needs-fixes", "The PDF update misses edge-case tests.")

const RECOVERY_MARKER = "repeated the same completed review"
const GENERIC_MARKER = "The turn ended without a successful finish call"

function syntheticTexts(messages: SessionV1.WithParts[]) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true)
    .map((part) => part.text)
}

function finishParts(messages: SessionV1.WithParts[]) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "finish")
}

// Title generation issues its own request on the first turn; filter it out
// so request assertions only cover the agent turns under test.
const turnHits = Effect.fn("test.turnHits")(function* () {
  const llm = yield* TestLLMServer
  const hits = yield* llm.hits
  return hits.filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
})

it.instance(
  "repeated literal review output triggers the recovery nudge and finish still completes",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { reason: "success", result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // Two identical generations earn one generic reminder, then the
      // recovery nudge; the nudged model finishes normally.
      expect(yield* turnHits()).toHaveLength(3)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(1)
      const recovery = nudges.filter((text) => text.includes(RECOVERY_MARKER))
      expect(recovery).toHaveLength(1)
      expect(nudges.map((text) => text.includes(RECOVERY_MARKER))).toEqual([false, true])

      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
      if (finishes[0]?.state.status === "completed") {
        expect(finishes[0].state.output).toContain("<alphacode-review>")
        // The model's own finish, not the stagnation backstop.
        expect(finishes[0].state.input.result).toBe(REPEAT)
      }
    }),
  20_000,
)

it.instance(
  "a review that ignores the recovery nudge completes from its established report",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Backstop",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // The failure mode from #176: the reviewer delivered its report first,
      // then restated the same short completion message forever, so the
      // recovery nudge kept being sent and the turn never terminated. The
      // queue holds more repetitions than the runtime may consume, so
      // terminating early is the only way the loop can stop.
      yield* llm.text(REPEAT)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // Four generations: the report, one nudge, then two restatements that
      // earn the single recovery nudge and the backstop.
      expect(yield* turnHits()).toHaveLength(4)
      expect(yield* llm.pending).toBe(2)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      // Exactly one recovery nudge, sent after the two restatements: the
      // loop never nudges again.
      const nudges = syntheticTexts(messages)
      expect(nudges.map((text) => text.includes(RECOVERY_MARKER))).toEqual([false, false, true])

      // The completion is a normal finish: completed, delivered on the
      // message the loop returns, carrying the report the reviewer had
      // already delivered — not the repeated completion message.
      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
      expect(finishParts([result])).toHaveLength(1)
      if (finishes[0]?.state.status === "completed") {
        expect(finishes[0].state.output).toContain("<alphacode-review>")
        expect(finishes[0].state.output).toContain("Edge cases untested")
        expect(finishes[0].state.input.result).toContain("<alphacode-review>")
      }
    }),
  20_000,
)

it.instance(
  "a recovery nudge the reviewer answers with progress completes nothing by itself",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Backstop reset",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // The report, its restatement — which earns the recovery nudge — and then
      // genuine progress: the reviewer runs a tool instead of restating. The
      // run that repeats afterwards is a fresh one, so the spent nudge must not
      // complete the review for it. Its own recovery nudge does, after the
      // second restatement of that run; the extra reply stays queued so only
      // early termination can end the turn.
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("glob", { pattern: "**/*.json" })
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // Six generations, not five: the fresh run was not completed by the
      // nudge the reviewer had already answered with a tool call.
      expect(yield* turnHits()).toHaveLength(6)
      expect(yield* llm.pending).toBe(1)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      // A recovery nudge after the first restatement, then the tool call earns
      // no reminder, then a fresh recovery nudge once the new run repeats.
      const nudges = syntheticTexts(messages)
      expect(nudges.map((text) => text.includes(RECOVERY_MARKER))).toEqual([false, true, false, true])

      // The completion is the backstop's normal finish, carrying the report
      // the turn already established rather than the repeated message.
      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
      expect(finishParts([result])).toHaveLength(1)
      if (finishes[0]?.state.status === "completed") {
        expect(finishes[0].state.output).toContain("Edge cases untested")
        expect(finishes[0].state.input.result).toContain("<alphacode-review>")
      }
    }),
  20_000,
)

it.instance(
  "stagnation without an established report keeps the existing finish gate",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Backstop gate",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // No generation ever carries a report envelope, so there is nothing to
      // complete from: the runtime must keep nudging and let the model finish,
      // which it eventually does.
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.text(DONE)
      yield* llm.tool("finish", { reason: "success", result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // All five scripted replies were consumed: stagnation alone never
      // completed the review.
      expect(yield* turnHits()).toHaveLength(5)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(1)
      expect(nudges.filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(3)

      // The only finish is the model's, with the result it passed.
      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
      if (finishes[0]?.state.status === "completed") {
        expect(finishes[0].state.input.result).toBe(REPEAT)
      }
    }),
  20_000,
)

it.instance(
  "repeated output from a non-review agent keeps the generic nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation scope",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { reason: "success", result: "Done." })

      yield* user(chat.id, "do the thing", "work")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // The heuristic is scoped to the review subagent: the primary agent's
      // identical repeats keep earning the generic reminder.
      expect(yield* turnHits()).toHaveLength(4)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(0)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(3)
      expect(finishParts(messages).map((part) => part.state.status)).toEqual(["completed"])
    }),
  20_000,
)
