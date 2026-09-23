import * as Tool from "./tool"
import { ToolFailure } from "@opencode-ai/llm"
import { ReviewReport } from "@opencode-ai/core/review-report"
import DESCRIPTION from "./finish.txt"
import { Effect, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session } from "../session/session"
import { Config } from "@/config/config"
import { finishGateError, reviewLoopState } from "../session/review-loop"

export const Parameters = Schema.Struct({
  reason: Schema.Union([Schema.Literal("success"), Schema.Literal("subagent_wait"), Schema.Literal("failure")]).annotate({
    description:
      "Why the agent is ending this turn: success when the task is complete, subagent_wait when progress depends on another subagent, or failure when the task could not be completed.",
  }),
  result: Schema.String.annotate({
    description:
      "The final result of the task: a concise summary of what was accomplished, presented to the user as the task outcome.",
  }),
})

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
          if (ctx.agent === "review") {
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
