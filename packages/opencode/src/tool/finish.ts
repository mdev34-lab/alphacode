import * as Tool from "./tool"
import { ToolFailure } from "@opencode-ai/llm"
import { ReviewReport } from "@opencode-ai/core/review-report"
import DESCRIPTION from "./finish.txt"
import { Effect, Option, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session } from "../session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Config } from "@/config/config"
import { finishGateError, reviewLoopState } from "../session/review-loop"
import { isReviewAgent } from "../agent/review-agents"

const DeclaredReasons = ["success", "subagent_wait", "failure"] as const

export const Reason = Schema.Literals(DeclaredReasons)

export type Reason = Schema.Schema.Type<typeof Reason>

/**
 * The full termination contract for a finished run, as delivered to a parent
 * through a `<termination reason="...">` element.
 *
 * The model only ever declares {@link Reason} on the finish tool; `cancelled`
 * cannot be declared there. A cancelled subagent never reaches a finish call —
 * the user stops it mid-run — so the runtime records the cancellation itself
 * instead of forcing the reason through a tool input the model never supplied.
 */
export const TerminationReason = Schema.Literals([...DeclaredReasons, "cancelled"])

export type TerminationReason = Schema.Schema.Type<typeof TerminationReason>

export const Parameters = Schema.Struct({
  reason: Reason.annotate({
    description:
      "Why the agent is ending this turn: success when the task is complete, subagent_wait when progress depends on another subagent, or failure when the task could not be completed.",
  }),
  result: Schema.String.annotate({
    description:
      "The final result of the task: a concise summary of what was accomplished, presented to the user as the task outcome.",
  }),
})

/**
 * Reads the termination reason the model declared on a completed finish call.
 *
 * Three cases, deliberately not collapsed into one default:
 *
 * - A record with no `reason` is a transcript written before the field existed.
 *   Those turns were successes, so absence reads as `success` and the loop
 *   still exits with a verdict.
 * - A record carrying a reason this build does not recognise is not a legacy
 *   transcript. It resolves to `undefined` rather than to `success`, so a
 *   future build's value is never silently upgraded into a delivered verdict by
 *   an older one.
 * - Anything that is not a record cannot be read at all and yields `undefined`.
 */
export function readTermination(part: SessionV1.ToolPart): Reason | undefined {
  if (part.tool !== FinishTool.id) return undefined
  if (part.state.status !== "completed") return undefined
  const input = part.state.input
  if (typeof input !== "object" || input === null) return undefined
  const declared = (input as { reason?: unknown }).reason
  if (declared === undefined) return "success"
  return Option.getOrUndefined(Schema.decodeUnknownOption(Reason)(declared))
}

export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.waitForOtherTools ?? Effect.void
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
          // The Review subagent completes its run through this same finish
          // tool, so the structured review result is gated here, at the
          // control-flow boundary: without a parseable report envelope the
          // call fails as recoverable model feedback and the run continues
          // instead of completing without a verdict.
          if (isReviewAgent(ctx.agent)) {
            const currentMessage = messages.find((message) => message.info.id === ctx.messageID)
            const delivery = ReviewReport.extract([
              ...(currentMessage?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
              params.result,
            ])
            if (!delivery.ok) {
              yield* Effect.logWarning("finish declined: review result missing or unparseable", {
                sessionID: ctx.sessionID,
                reason: delivery.failure.reason,
              })
              return yield* Effect.fail(
                new ToolFailure({
                  message: [
                    `Review finish rejected: ${delivery.failure.message}.`,
                    `The review run cannot complete until finish is called with a result containing a valid <${ReviewReport.TAG}> report envelope: {"version": 1, "revision": string, "assessment": "approved" | "needs-fixes", "summary": string, "findings": [{"severity": "critical" | "important" | "minor", "title": string}]}.`,
                    `Emit the envelope and call finish again; the review continues.`,
                  ].join(" "),
                }),
              )
            }
          }
          const cfg = yield* config.get()
          const maxIterations = cfg.review_loop?.max_iterations ?? 5
          const reviewState = reviewLoopState(messages, maxIterations)
          const gateError = finishGateError(reviewState)
          if (gateError) {
            const phase = reviewState.workSinceReview
              ? "work"
              : reviewState.verdict === "needs-fixes"
                ? "work"
                : "review"
            yield* Effect.logWarning("finish declined with review nudge", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              phase,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
              workSinceReview: reviewState.workSinceReview,
            })
            // Persist the nudge on the failed part so the next finish call for the
            // same work is recognised as an explicit skip instead of being declined again.
            yield* ctx.metadata({
              title: "Review suggested",
              metadata: {
                review: {
                  nudged: true,
                  verdict: reviewState.verdict,
                  reviews: reviewState.reviews,
                  maxIterations: reviewState.maxIterations,
                },
              },
            })
            return yield* Effect.fail(new ToolFailure({ message: gateError.message }))
          }

          const skipped =
            reviewState.nudged && (reviewState.verdict === "pending" || reviewState.verdict === "needs-fixes")
          if (skipped) {
            yield* Effect.logWarning("review skipped by explicit finish", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
            })
          }

          if (reviewState.verdict === "cap") {
            yield* Effect.logWarning("review loop terminated at cap", {
              sessionID: ctx.sessionID,
              phase: "review",
              reason: "review-cap",
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
            })
          }

          yield* Effect.gen(function* () {
            const existing = yield* todo.get(ctx.sessionID)
            const hasOpen = existing.some((t) => t.status === "pending" || t.status === "in_progress")
            if (!hasOpen) return
            const closed = existing.map((t) =>
              t.status === "pending" || t.status === "in_progress" ? { ...t, status: "cancelled" as const } : t,
            )
            yield* todo.update({ sessionID: ctx.sessionID, todos: closed })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("finish todo cleanup failed, but finish still succeeds", {
                sessionID: ctx.sessionID,
                cause,
              }),
            ),
          )

          return {
            title: "Task completed",
            output: params.result,
            metadata: {
              termination: { reason: params.reason },
              review: {
                verdict: reviewState.verdict,
                reviews: reviewState.reviews,
                maxIterations: reviewState.maxIterations,
                termination: skipped ? "skipped" : reviewState.verdict === "cap" ? "review-cap" : "approved",
              },
            },
          }
        }),
    }
  }),
)
