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
  test("defaults to three consecutive identical outputs", () => {
    expect(ReviewStagnation.resolveRepeats({})).toBe(3)
    expect(ReviewStagnation.DEFAULT_REPEATS).toBe(3)
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
      name: "two identical outputs stay below the default threshold",
      messages: [userMsg("review this"), reviewMsg(A), nudgeMsg(), reviewMsg(A)],
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
// Loop integration: the heuristic wired into the actual session loop.
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
const itFast = testEffect(compileRoot({ experimentalEventSystem: true, reviewStagnationRepeats: 2 }))
const itOff = testEffect(compileRoot({ experimentalEventSystem: true, reviewStagnationRepeats: 0 }))

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
const OTHER = report("approved", "The PDF update is clean.")
const ANOTHER = report("needs-fixes", "The PDF update misses different edge-case tests.")

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
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // Three identical generations earn two generic reminders, then the
      // recovery nudge; the nudged model finishes normally.
      expect(yield* turnHits()).toHaveLength(4)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(2)
      const recovery = nudges.filter((text) => text.includes(RECOVERY_MARKER))
      expect(recovery).toHaveLength(1)
      expect(nudges.map((text) => text.includes(RECOVERY_MARKER))).toEqual([false, false, true])

      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["completed"])
      if (finishes[0]?.state.status === "completed") {
        expect(finishes[0].state.output).toContain("<alphacode-review>")
      }
    }),
  20_000,
)

it.instance(
  "a prose-only finish after the recovery nudge is still rejected",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation gating",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { result: "Needs fixes: one Important finding." })
      yield* llm.tool("finish", { result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // The recovery nudge does not weaken the review result contract: the
      // envelope-less finish fails as recoverable feedback, and only the
      // envelope-carrying retry completes the review.
      expect(yield* turnHits()).toHaveLength(5)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(syntheticTexts(messages).filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(1)
      const finishes = finishParts(messages)
      expect(finishes.map((part) => part.state.status)).toEqual(["error", "completed"])
      if (finishes[0]?.state.status === "error") {
        expect(finishes[0].state.error).toContain("no <alphacode-review> report envelope was found")
      }
    }),
  20_000,
)

it.instance(
  "tool activity between repeats prevents the recovery nudge",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig
      const fs = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation reads",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "probe.txt")
      yield* fs.writeWithDirs(file, "probe content")
      yield* llm.text(REPEAT)
      yield* llm.tool("read", { filePath: file })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // The completed read is real review work: the run on either side never
      // reaches the threshold, so every reminder stays generic.
      expect(yield* turnHits()).toHaveLength(5)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(0)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(3)
      const reads = messages
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "read")
      expect(reads.map((part) => part.state.status)).toEqual(["completed"])
      expect(finishParts(messages).map((part) => part.state.status)).toEqual(["completed"])
    }),
  20_000,
)

it.instance(
  "distinct review outputs never trigger the recovery nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation distinct",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(OTHER)
      yield* llm.text(ANOTHER)
      yield* llm.tool("finish", { result: ANOTHER })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      expect(yield* turnHits()).toHaveLength(4)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(0)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(3)
      expect(finishParts(messages).map((part) => part.state.status)).toEqual(["completed"])
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
      yield* llm.tool("finish", { result: "Done." })

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

itFast.instance(
  "the repeat threshold is configurable",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation threshold",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // With the threshold at 2, the second identical generation already
      // earns the recovery nudge.
      expect(yield* turnHits()).toHaveLength(3)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.map((text) => text.includes(RECOVERY_MARKER))).toEqual([false, true])
      expect(finishParts(messages).map((part) => part.state.status)).toEqual(["completed"])
    }),
  20_000,
)

itOff.instance(
  "a threshold of 0 disables the recovery nudge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Stagnation disabled",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.text(REPEAT)
      yield* llm.tool("finish", { result: REPEAT })

      yield* user(chat.id, TASK_PROMPT)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      expect(yield* turnHits()).toHaveLength(4)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const nudges = syntheticTexts(messages)
      expect(nudges.filter((text) => text.includes(RECOVERY_MARKER))).toHaveLength(0)
      expect(nudges.filter((text) => text.includes(GENERIC_MARKER))).toHaveLength(3)
      expect(finishParts(messages).map((part) => part.state.status)).toEqual(["completed"])
    }),
  20_000,
)
