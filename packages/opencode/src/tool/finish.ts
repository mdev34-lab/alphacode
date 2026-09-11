import * as Tool from "./tool"
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

// Every user turn is a task from the execution protocol's perspective, so agents
// with finishTool enabled (the default) may only end their turn by calling finish.
// The review gate is enforced here, at the actual completion boundary.
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
          const cfg = yield* config.get()
          const maxIterations = cfg.review_loop?.max_iterations ?? 5
          // Tool.Context.messages is the model-request snapshot and can be stale when
          // finish follows another tool call in the same assistant response. Read the
          // persisted session history at the completion boundary instead.
          const messages = yield* sessions.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const reviewState = reviewLoopState(messages, maxIterations)
          const gateError = finishGateError(reviewState)
          if (gateError) {
            yield* Effect.logWarning("finish blocked by review gate", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
              workSinceReview: reviewState.workSinceReview,
            })
            return {
              title: "Review required",
              output: gateError.message,
              metadata: {
                review: {
                  verdict: reviewState.verdict,
                  reviews: reviewState.reviews,
                  maxIterations: reviewState.maxIterations,
                  termination: "blocked",
                },
              },
            }
          }

          if (reviewState.verdict === "cap") {
            yield* Effect.logWarning("review loop terminated at cap", {
              sessionID: ctx.sessionID,
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
