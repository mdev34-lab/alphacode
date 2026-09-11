import * as Tool from "./tool"
import DESCRIPTION from "./finish.txt"
import { Effect, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session } from "../session/session"
import { finishGateError, latestReviewVerdict } from "../session/review-loop"

export const Parameters = Schema.Struct({
  result: Schema.String.annotate({
    description:
      "The final result of the task: a concise summary of what was accomplished, presented to the user as the task outcome.",
  }),
})

// Every user turn is a task from the execution protocol's perspective, so
// agents with finishTool enabled (the default) may only end their turn by
// calling this tool — the session loop resists end-of-stream stops until it
// completes, even when the turn used no other tools. On success it also
// makes a best-effort attempt to close any remaining open todos for the
// session as a safety net. The cleanup is logged but does not block task
// completion if it fails.
export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
          const verdict = latestReviewVerdict(messages)
          const gateError = finishGateError(verdict)
          if (gateError) {
            yield* Effect.logWarning("finish blocked by review gate", {
              sessionID: ctx.sessionID,
              verdict,
            })
            return yield* Effect.fail(gateError)
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
            metadata: {},
          }
        }),
    }
  }),
)
