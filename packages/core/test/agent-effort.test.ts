import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffortPolicy } from "@opencode-ai/core/effort-policy"
import {
  REVIEW_LOOP_METADATA,
  reviewLoopState,
  type ReviewHistoryMessage,
  type ReviewLoopState,
} from "@opencode-ai/core/review-loop"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

function testLayer(directory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: path.join(directory, "global") })],
  ])
}

const provider = {
  api: { type: "native", settings: {} },
  request: {
    headers: {},
    body: {},
  },
  models: {},
}

/** Baseline reviewed-work state: one unit of declared file-writing work, no reviews yet. */
function workState(overrides: Partial<ReviewLoopState> = {}): ReviewLoopState {
  return {
    verdict: "pending",
    reviews: 0,
    maxIterations: 2,
    workSinceReview: true,
    reviewInProgress: false,
    nudged: false,
    phase: "work",
    workSeen: true,
    openFindings: 0,
    blockingFindings: 0,
    stale: false,
    ...overrides,
  }
}

function evaluate(effort: AgentEffort.Level, state: ReviewLoopState, reviewerAvailable = true) {
  return EffortPolicy.evaluateFinish({ effort, reason: "success", state, reviewerAvailable })
}

function envelope(assessment: "approved" | "needs-fixes", findings: ReadonlyArray<Record<string, unknown>> = []) {
  return [
    "<alphacode-review>",
    JSON.stringify({ version: 1, revision: "uncommitted", assessment, summary: "assessment", findings }),
    "</alphacode-review>",
  ].join("\n")
}

function reviewTask(
  assessment: "approved" | "needs-fixes",
  findings: ReadonlyArray<Record<string, unknown>> = [],
): ReviewHistoryMessage {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "review", background: false },
          output: envelope(assessment, findings),
        },
      },
    ],
  }
}

function writeTask(): ReviewHistoryMessage {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "done",
          metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } },
        },
      },
    ],
  }
}

function userTurn(text = "do the work"): ReviewHistoryMessage {
  const part = { type: "text", text }
  return { info: { role: "user" }, parts: [part] }
}

describe("effort policy – the two switches", () => {
  it.effect("maps each level to its exact pass budget and validation gate", () =>
    Effect.sync(() => {
      expect(EffortPolicy.passLimit("fast")).toBe(0)
      expect(EffortPolicy.passLimit("medium")).toBe(2)
      expect(EffortPolicy.passLimit("thorough")).toBeUndefined()
      expect(EffortPolicy.validationGate("fast")).toBe("minimal")
      expect(EffortPolicy.validationGate("medium")).toBe("standard")
      expect(EffortPolicy.validationGate("thorough")).toBe("full")
      expect(EffortPolicy.requiredCategories("minimal")).toEqual(["syntax", "smoke"])
      expect(EffortPolicy.requiredCategories("standard")).toEqual(["tests"])
      expect(EffortPolicy.requiredCategories("full")).toEqual(["tests", "typecheck", "parity"])
    }),
  )

  it.effect("resolves untrusted levels to medium without throwing", () =>
    Effect.sync(() => {
      expect(AgentEffort.resolve(undefined)).toBe("medium")
      expect(AgentEffort.resolve("bogus")).toBe("medium")
      for (const level of AgentEffort.levels) expect(AgentEffort.resolve(level)).toBe(level)
    }),
  )
})

describe("finish evaluation", () => {
  it.effect("fast delivers unreviewed work as unreviewed, never budget-exhausted", () =>
    Effect.sync(() => {
      const outcome = evaluate("fast", workState())
      expect(outcome.deliver).toBe(true)
      expect(outcome.disposition).toBe("unreviewed")
      expect(outcome.termination).toBe("unreviewed")
      // Fast's zero required passes is not a serialized cap.
      expect(outcome.maxIterations).toBeUndefined()
    }),
  )

  it.effect("fast labels a work-in-tree delivery from an actual approved review as approved", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "fast",
        workState({
          verdict: "approved",
          reviews: 1,
          workSinceReview: false,
          phase: "review",
          lastReviewVerdict: "approved",
        }),
      )
      expect(outcome.deliver).toBe(true)
      expect(outcome.disposition).toBe("reviewed")
      expect(outcome.termination).toBe("approved")
    }),
  )

  it.effect("fast labels a review's open findings honestly", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "fast",
        workState({
          verdict: "needs-fixes",
          reviews: 1,
          workSinceReview: false,
          lastReviewVerdict: "needs-fixes",
          openFindings: 2,
          blockingFindings: 1,
        }),
      )
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("findings-open")
    }),
  )

  it.effect("medium declines unreviewed work with recoverable feedback", () =>
    Effect.sync(() => {
      const outcome = evaluate("medium", workState())
      expect(outcome.deliver).toBe(false)
      expect(outcome.termination).toBe("unreviewed")
      expect(outcome.feedback).toContain("independent review")
      expect(outcome.maxIterations).toBe(2)
    }),
  )

  it.effect("medium blocks a successful finish when the reviewer cannot run (#233)", () =>
    Effect.sync(() => {
      const outcome = evaluate("medium", workState(), false)
      expect(outcome.deliver).toBe(false)
      expect(outcome.termination).toBe("unreviewed")
      expect(outcome.disposition).toBe("unreviewed")
      expect(outcome.feedback).toContain("Review blocked")
      expect(outcome.unavailableReason).toBeTruthy()

      const declared = EffortPolicy.evaluateFinish({
        effort: "medium",
        reason: "failure",
        state: workState(),
        reviewerAvailable: false,
      })
      expect(declared.deliver).toBe(true)
      expect(declared.termination).toBe("review-blocked")
      expect(declared.unavailableReason).toBeTruthy()
    }),
  )

  it.effect("medium delivers after one clean pass, capped at two", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "medium",
        workState({
          verdict: "approved",
          reviews: 1,
          workSinceReview: false,
          phase: "review",
          lastReviewVerdict: "approved",
        }),
      )
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("approved")
      expect(outcome.maxIterations).toBe(2)
    }),
  )

  it.effect("minor-only findings do not force a second pass", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "medium",
        workState({
          verdict: "approved",
          reviews: 1,
          workSinceReview: false,
          phase: "review",
          lastReviewVerdict: "approved",
          openFindings: 2,
          blockingFindings: 0,
        }),
      )
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("approved")
    }),
  )

  it.effect("medium declines while blocking findings remain below the cap", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "medium",
        workState({
          verdict: "needs-fixes",
          reviews: 1,
          workSinceReview: false,
          lastReviewVerdict: "needs-fixes",
          openFindings: 3,
          blockingFindings: 2,
        }),
      )
      expect(outcome.deliver).toBe(false)
      expect(outcome.feedback).toContain("blocking")
    }),
  )

  it.effect("corrective edits do not consume passes: stale work below the cap requires another pass", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "medium",
        workState({
          verdict: "pending",
          reviews: 1,
          workSinceReview: true,
          lastReviewVerdict: "approved",
        }),
      )
      expect(outcome.deliver).toBe(false)
      expect(outcome.feedback).toContain("changed after the last review")
    }),
  )

  it.effect("two-pass exhaustion delivers honestly instead of looping", () =>
    Effect.sync(() => {
      const blocking = evaluate(
        "medium",
        workState({
          verdict: "needs-fixes",
          reviews: 2,
          workSinceReview: false,
          lastReviewVerdict: "needs-fixes",
          openFindings: 1,
          blockingFindings: 1,
        }),
      )
      expect(blocking.deliver).toBe(true)
      expect(blocking.termination).toBe("budget-exhausted")
      expect(blocking.disposition).toBe("reviewed")

      const stale = evaluate(
        "medium",
        workState({
          verdict: "approved",
          reviews: 2,
          workSinceReview: true,
          lastReviewVerdict: "approved",
        }),
      )
      expect(stale.deliver).toBe(true)
      expect(stale.termination).toBe("findings-open")
      expect(stale.disposition).toBe("reviewed")
    }),
  )

  it.effect("repeating finish never bypasses a required review", () =>
    Effect.sync(() => {
      const state = workState({ nudged: true })
      const first = evaluate("medium", state)
      const second = evaluate("medium", state)
      expect(first.deliver).toBe(false)
      expect(second.deliver).toBe(false)
      expect(second.feedback).toBe(first.feedback)
    }),
  )

  it.effect("a review already in progress declines instead of delivering", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "medium",
        workState({ reviewInProgress: true, reviews: 1, workSinceReview: false, lastReviewVerdict: "approved" }),
      )
      expect(outcome.deliver).toBe(false)
    }),
  )

  it.effect("thorough declines until a clean current review exists", () =>
    Effect.sync(() => {
      expect(evaluate("thorough", workState()).deliver).toBe(false)
      expect(
        evaluate(
          "thorough",
          workState({
            verdict: "needs-fixes",
            reviews: 3,
            workSinceReview: false,
            lastReviewVerdict: "needs-fixes",
            blockingFindings: 1,
          }),
        ).deliver,
      ).toBe(false)
      expect(
        evaluate(
          "thorough",
          workState({
            verdict: "pending",
            reviews: 3,
            workSinceReview: true,
            lastReviewVerdict: "approved",
          }),
        ).deliver,
      ).toBe(false)
    }),
  )

  it.effect("thorough blocks success when the reviewer is unavailable, never as approval", () =>
    Effect.sync(() => {
      const outcome = evaluate("thorough", workState(), false)
      expect(outcome.deliver).toBe(false)
      expect(outcome.disposition).toBe("unreviewed")
      expect(outcome.maxIterations).toBeUndefined()
      expect(outcome.feedback).toContain("Review blocked")
    }),
  )

  it.effect("thorough delivers an approved review with no finite cap", () =>
    Effect.sync(() => {
      const outcome = evaluate(
        "thorough",
        workState({
          verdict: "approved",
          reviews: 4,
          workSinceReview: false,
          phase: "review",
          lastReviewVerdict: "approved",
        }),
      )
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("approved")
      expect(outcome.maxIterations).toBeUndefined()
    }),
  )

  it.effect("failure and subagent_wait deliver without an approval ritual", () =>
    Effect.sync(() => {
      const failed = EffortPolicy.evaluateFinish({
        effort: "medium",
        reason: "failure",
        state: workState(),
        reviewerAvailable: true,
      })
      // #233: a declared failure is still reviewed when a reviewer can run.
      expect(failed.deliver).toBe(false)
      expect(failed.feedback).toContain("requires at least one independent review")

      const waiting = EffortPolicy.evaluateFinish({
        effort: "medium",
        reason: "subagent_wait",
        state: workState(),
        reviewerAvailable: true,
      })
      expect(waiting.deliver).toBe(true)
      expect(waiting.termination).toBe("waiting")
      expect(waiting.disposition).toBe("unreviewed")
    }),
  )

  it.effect("read-only turns are exempt but labelled distinctly from approval", () =>
    Effect.sync(() => {
      const quiet = workState({ workSeen: false, workSinceReview: false, verdict: "none", phase: "review" })
      const success = evaluate("thorough", quiet)
      expect(success.deliver).toBe(true)
      expect(success.termination).toBe("not-required")

      const failed = EffortPolicy.evaluateFinish({
        effort: "thorough",
        reason: "failure",
        state: quiet,
        reviewerAvailable: true,
      })
      expect(failed.deliver).toBe(true)
      expect(failed.termination).toBe("unreviewed")
    }),
  )
})

describe("validation derivation", () => {
  const check = (category: EffortPolicy.ValidationCategory, status: EffortPolicy.ValidationStatus) => ({
    category,
    status,
    detail: `${category} ${status}`,
  })

  it.effect("minimal is satisfied by either applicable check", () =>
    Effect.sync(() => {
      const syntax = EffortPolicy.deriveValidation({
        effort: "fast",
        declaration: { checks: [check("syntax", "passed")] },
      })
      expect(syntax.status).toBe("passed")
      const smoke = EffortPolicy.deriveValidation({
        effort: "fast",
        declaration: { checks: [check("smoke", "passed")] },
      })
      expect(smoke.status).toBe("passed")
    }),
  )

  it.effect("minimal accepts both categories declared explicitly not-applicable", () =>
    Effect.sync(() => {
      const report = EffortPolicy.deriveValidation({
        effort: "fast",
        declaration: { checks: [check("syntax", "not-applicable"), check("smoke", "not-applicable")] },
      })
      expect(report.status).toBe("passed")
    }),
  )

  it.effect("minimal stays incomplete without an actually-passed applicable check", () =>
    Effect.sync(() => {
      expect(EffortPolicy.deriveValidation({ effort: "fast" }).status).toBe("incomplete")
      expect(EffortPolicy.deriveValidation({ effort: "fast", declaration: { checks: [] } }).status).toBe("incomplete")
      expect(
        EffortPolicy.deriveValidation({ effort: "fast", declaration: { checks: [check("syntax", "not-run")] } }).status,
      ).toBe("incomplete")
      expect(
        EffortPolicy.deriveValidation({
          effort: "fast",
          declaration: { checks: [check("syntax", "not-run"), check("tests", "passed")] },
        }).status,
      ).toBe("incomplete")
    }),
  )

  it.effect("a failed check fails the report regardless of gate or other passes", () =>
    Effect.sync(() => {
      const minimal = EffortPolicy.deriveValidation({
        effort: "fast",
        declaration: { checks: [check("syntax", "passed"), check("smoke", "failed")] },
      })
      expect(minimal.status).toBe("failed")
      const full = EffortPolicy.deriveValidation({
        effort: "thorough",
        declaration: {
          checks: [check("tests", "passed"), check("typecheck", "passed"), check("parity", "failed")],
        },
      })
      expect(full.status).toBe("failed")
    }),
  )

  it.effect("standard requires tests evidence only", () =>
    Effect.sync(() => {
      expect(
        EffortPolicy.deriveValidation({ effort: "medium", declaration: { checks: [check("tests", "passed")] } }).status,
      ).toBe("passed")
      expect(
        EffortPolicy.deriveValidation({ effort: "medium", declaration: { checks: [check("smoke", "passed")] } }).status,
      ).toBe("incomplete")
      expect(
        EffortPolicy.deriveValidation({ effort: "medium", declaration: { checks: [check("tests", "not-run")] } })
          .status,
      ).toBe("incomplete")
    }),
  )

  it.effect("full requires tests, typecheck and parity evidence", () =>
    Effect.sync(() => {
      const complete = EffortPolicy.deriveValidation({
        effort: "thorough",
        declaration: {
          checks: [check("tests", "passed"), check("typecheck", "passed"), check("parity", "passed")],
        },
      })
      expect(complete.status).toBe("passed")
      const missingParity = EffortPolicy.deriveValidation({
        effort: "thorough",
        declaration: { checks: [check("tests", "passed"), check("typecheck", "passed")] },
      })
      expect(missingParity.status).toBe("incomplete")
    }),
  )

  it.effect("the report is declared agent-reported evidence, echoed verbatim", () =>
    Effect.sync(() => {
      const report = EffortPolicy.deriveValidation({
        effort: "medium",
        declaration: { checks: [check("tests", "passed")] },
      })
      expect(report.gate).toBe("standard")
      expect(report.source).toBe("agent-reported")
      expect(report.checks).toEqual([check("tests", "passed")])
    }),
  )
})

describe("review severity and lifecycle (persisted-history evaluator)", () => {
  it.effect("critical and important findings block; minor findings do not; empty needs-fixes floors at one", () =>
    Effect.sync(() => {
      const blocking = reviewLoopState(
        [
          userTurn(),
          writeTask(),
          reviewTask("needs-fixes", [
            { severity: "critical", title: "broken" },
            { severity: "important", title: "risky" },
            { severity: "minor", title: "style" },
          ]),
        ],
        { effort: "medium" },
      )
      expect(blocking.blockingFindings).toBe(2)
      expect(blocking.openFindings).toBe(3)

      const minorOnly = reviewLoopState(
        [userTurn(), writeTask(), reviewTask("approved", [{ severity: "minor", title: "style" }])],
        { effort: "medium" },
      )
      expect(minorOnly.blockingFindings).toBe(0)
      expect(minorOnly.verdict).toBe("approved")

      const empty = reviewLoopState([userTurn(), writeTask(), reviewTask("needs-fixes")], { effort: "medium" })
      expect(empty.blockingFindings).toBe(1)
      expect(empty.verdict).toBe("needs-fixes")
    }),
  )

  it.effect("a new user task resets the previous task's review budget", () =>
    Effect.sync(() => {
      const state = reviewLoopState(
        [userTurn("first"), writeTask(), reviewTask("approved"), userTurn("second"), writeTask()],
        { effort: "medium" },
      )
      expect(state.reviews).toBe(0)
      expect(state.verdict).toBe("pending")
      expect(state.workSeen).toBe(true)
    }),
  )

  it.effect("a background review and a failed review delivery never count as a pass", () =>
    Effect.sync(() => {
      const backgroundReview: ReviewHistoryMessage = {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "review", background: true },
              output: envelope("approved"),
            },
          },
        ],
      }
      const background = reviewLoopState([userTurn(), writeTask(), backgroundReview], { effort: "medium" })
      expect(background.reviews).toBe(0)

      const malformedReview: ReviewHistoryMessage = {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "review", background: false },
              output: "Assessment: Approved, I think? [Approved | Needs fixes]",
            },
          },
        ],
      }
      const malformed = reviewLoopState([userTurn(), writeTask(), malformedReview], { effort: "medium" })
      expect(malformed.reviews).toBe(1)
      expect(malformed.lastReviewVerdict).toBeUndefined()
      expect(malformed.verdict).not.toBe("approved")
    }),
  )

  it.effect("legacy transcripts stay readable on the numeric cap", () =>
    Effect.sync(() => {
      const approved = reviewLoopState(
        [userTurn(), writeTask(), ...Array.from({ length: 5 }, () => reviewTask("approved"))],
        5,
      )
      expect(approved.reviews).toBe(5)
      expect(approved.maxIterations).toBe(5)
      expect(approved.verdict).toBe("approved")

      // At the legacy cap with no clean approval, the verdict is the cap —
      // never silently upgraded to approved.
      const capped = reviewLoopState(
        [
          userTurn(),
          writeTask(),
          ...Array.from({ length: 4 }, () => reviewTask("approved")),
          reviewTask("needs-fixes", [{ severity: "critical", title: "broken" }]),
        ],
        5,
      )
      expect(capped.reviews).toBe(5)
      expect(capped.verdict).toBe("cap")
      expect(capped.blockingFindings).toBe(1)
    }),
  )

  it.effect("thorough is until-clean in the evaluator: no finite cap, no legacy override", () =>
    Effect.sync(() => {
      const state = reviewLoopState(
        [userTurn(), writeTask(), ...Array.from({ length: 5 }, () => reviewTask("approved"))],
        { effort: "thorough" },
      )
      expect(state.maxIterations).toBe(Number.POSITIVE_INFINITY)
      expect(state.verdict).toBe("approved")
    }),
  )
})

describe("config detection and migration", () => {
  it.effect("detects the nested policy-only agent setting as v2, not as a legacy map", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.isV1({ agent: { effort: "fast" } })).toBe(false)
      expect(ConfigMigrateV1.isV1({ agent: { effort: "fast" }, agents: {}, default_agent: "writer" })).toBe(false)
      expect(ConfigMigrateV1.isV1({ agent: { effort: "fast" }, providers: {} })).toBe(false)
      expect(ConfigMigrateV1.isV1({ agent: {} })).toBe(false)
      expect(ConfigMigrateV1.isV1({ agent: { writer: { description: "named" } } })).toBe(true)
      // A key named `effort` with an object value is a named agent, not the setting.
      expect(ConfigMigrateV1.isV1({ agent: { effort: { description: "named effort agent" } } })).toBe(true)
      expect(ConfigMigrateV1.isV1({ agent: { effort: "fast", writer: { description: "named" } } })).toBe(true)
      expect(ConfigMigrateV1.isV1({ mode: { writer: { prompt: "p" } } })).toBe(true)
      expect(ConfigMigrateV1.isV1({ default_agent: "writer" })).toBe(false)
    }),
  )

  it.effect("migrates the v1 scalar effort into the canonical nested agent setting", () =>
    Effect.sync(() => {
      const migrated = ConfigMigrateV1.migrate({ agent: { effort: "thorough" } })
      expect(migrated.agent).toEqual({ effort: "thorough" })
      expect("effort" in migrated).toBe(false)
      // The scalar setting never becomes a fake named agent.
      expect(migrated.agents).toEqual({})
      Schema.decodeUnknownSync(Config.Info)(migrated, { errors: "all" })
    }),
  )

  it.effect("a legacy object-valued effort entry migrates as a named agent, not the setting", () =>
    Effect.sync(() => {
      const migrated = ConfigMigrateV1.migrate({ agent: { effort: { description: "named effort agent" } } })
      expect(migrated.agent).toBeUndefined()
      expect(migrated.agents?.effort).toBeDefined()
      Schema.decodeUnknownSync(Config.Info)(migrated, { errors: "all" })
    }),
  )

  it.effect("native v2 agents and providers survive migration with native-over-legacy precedence", () =>
    Effect.sync(() => {
      const migrated = ConfigMigrateV1.migrate(
        {
          snapshot: false,
          agent: { effort: "fast", legacy: { description: "legacy definition" } },
          mode: { migrator: { description: "from mode" }, writer: { description: "from mode writer" } },
        },
        {
          agents: { writer: { description: "native writer" }, scribe: { description: "native only" } },
          providers: { custom: provider },
        },
      )
      expect(migrated.agent).toEqual({ effort: "fast" })
      expect(entry(migrated.agents?.writer).description).toBe("native writer")
      expect(entry(migrated.agents?.scribe).description).toBe("native only")
      expect(entry(migrated.agents?.legacy).description).toBe("legacy definition")
      expect(entry(migrated.agents?.migrator).description).toBe("from mode")
      expect(migrated.providers?.custom).toBeDefined()
      Schema.decodeUnknownSync(Config.Info)(migrated, { errors: "all" })
    }),
  )

  it.effect("the v2 schema admits all three levels at the nested location and rejects invalid ones", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(Config.Info, { errors: "all", onExcessProperty: "ignore" })
      for (const level of AgentEffort.levels) expect(Option.isSome(decode({ agent: { effort: level } }))).toBe(true)
      expect(Option.isSome(decode({ agent: { effort: "bogus" } }))).toBe(false)
      // A stale top-level `effort` is no longer a v2 field: it is ignored, not honoured.
      const thorough = decode({ effort: "thorough", agent: { effort: "thorough" } })
      expect(Option.isSome(thorough) && thorough.value.agent?.effort).toBe("thorough")
    }),
  )
})

/** Narrow an unknown migrated map entry for honest field assertions. */
function entry(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

describe("config load probes", () => {
  it.live("loads the literal agent.effort alongside native v2 agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                agent: { effort: "fast" },
                agents: { writer: { description: "native writer", mode: "primary" } },
                default_agent: "writer",
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            const info = documents[0]?.info
            expect(info?.agent?.effort).toBe("fast")
            expect(info?.agents?.writer?.description).toBe("native writer")
            expect(info?.default_agent).toBe("writer")
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads every valid effort scalar at the nested location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          // A fresh layer per level re-reads the file, one document per load.
          for (const level of AgentEffort.levels) {
            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ agent: { effort: level } })),
            )
            const documents = yield* Effect.gen(function* () {
              const config = yield* Config.Service
              return (yield* config.entries()).filter((entry) => entry.type === "document")
            }).pipe(Effect.provide(testLayer(tmp.path)))
            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.agent?.effort).toBe(level)
          }
        }),
      ),
    ),
  )

  it.live("rejects an invalid effort scalar without loading the document", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ agent: { effort: "bogus" } })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates a mixed legacy document without dropping native agents or providers", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                snapshot: false,
                agent: { effort: "medium", legacy: { description: "legacy definition" } },
                mode: { migrator: { description: "from mode" } },
                agents: { writer: { description: "native writer" } },
                providers: { custom: provider },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            const info = documents[0]?.info
            expect(info?.agent?.effort).toBe("medium")
            expect(info?.agents?.writer?.description).toBe("native writer")
            expect(info?.agents?.legacy?.description).toBe("legacy definition")
            expect(info?.agents?.migrator?.description).toBe("from mode")
            expect(info?.providers?.custom).toBeDefined()
            expect(info?.snapshots).toBe(false)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("preserves a legacy object-named effort agent through load", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({ snapshot: false, agent: { effort: { description: "named effort agent" } } }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            const info = documents[0]?.info
            expect(info?.agent?.effort).toBeUndefined()
            expect(info?.agents?.effort?.description).toBe("named effort agent")
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("rejects an invalid scalar even in a legacy document", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({ snapshot: false, agent: { effort: "bogus" } }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )
})

describe("effort policy – an approval never survives later work and an errored attempt", () => {
  const erroredReviewTask = (): ReviewHistoryMessage => {
    const state = {
      status: "error",
      input: { subagent_type: "review", background: false },
      error: "the review dispatch failed",
    }
    return {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "task", state }],
    }
  }

  // Approved, then more file writes, then a review attempt that errored.
  const staleThenErrored = (effort: AgentEffort.Level) =>
    reviewLoopState([userTurn(), writeTask(), reviewTask("approved"), writeTask(), erroredReviewTask()], { effort })

  it.effect("medium reaches its cap as budget-exhausted, never approved", () =>
    Effect.sync(() => {
      const state = staleThenErrored("medium")
      expect(state.lastReviewVerdict).toBeUndefined()
      const outcome = evaluate("medium", state)
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("budget-exhausted")
    }),
  )

  it.effect("thorough declines again rather than delivering an approval", () =>
    Effect.sync(() => {
      const state = staleThenErrored("thorough")
      const outcome = evaluate("thorough", state)
      expect(outcome.deliver).toBe(false)
      expect(outcome.termination).not.toBe("approved")
    }),
  )

  it.effect("fast labels the delivery unreviewed, never approved", () =>
    Effect.sync(() => {
      const outcome = evaluate("fast", staleThenErrored("fast"))
      expect(outcome.deliver).toBe(true)
      expect(outcome.termination).toBe("unreviewed")
    }),
  )
})
