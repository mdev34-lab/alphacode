import * as Tool from "./tool"
import { ToolFailure } from "@opencode-ai/llm"
import DESCRIPTION from "./finish.txt"
import { Effect, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session } from "../session/session"
import { Config } from "@/config/config"
import { finishGateError, reviewLoopState } from "../session/review-loop"

export const Parameters = Schema.Struct({
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
          const cfg = yield* config.get()
          const maxIterations = cfg.review_loop?.max_iterations ?? 5
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
          const reviewState = reviewLoopState(messages, maxIterations)
          const gateError = finishGateError(reviewState)
          if (gateError) {
            const phase = reviewState.workSinceReview
              ? "work"
              : reviewState.verdict === "needs-fixes"
                ? "work"
                : "review"
            yield* Effect.logWarning("finish blocked by review gate", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              phase,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
              workSinceReview: reviewState.workSinceReview,
            })
            return yield* Effect.fail(new ToolFailure({ message: gateError.message }))
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
              t.status === "pending" || t.status === "in_progress"
                ? { ...t, status: "cancelled" as const }
                : t,
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
              review: {
                verdict: reviewState.verdict,
                reviews: reviewState.reviews,
                maxIterations: reviewState.maxIterations,
                ...(reviewState.verdict === "cap" ? { termination: "review-cap" } : { termination: "approved" }),
              },
            },
          }
        }),
    }
  }),
)
