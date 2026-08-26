import * as Tool from "./tool"
import DESCRIPTION from "./finish.txt"
import { Effect, Schema } from "effect"
import { Todo } from "../session/todo"

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
// closes any remaining open todos for the session as a safety net, ensuring
// no dangling pending/in_progress items remain.
export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
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
          }).pipe(Effect.catch(() => Effect.void))

          return {
            title: "Task completed",
            output: params.result,
            metadata: {},
          }
        }),
    }
  }),
)
