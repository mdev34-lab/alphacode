import * as Tool from "./tool"
import DESCRIPTION from "./finish.txt"
import { Effect, Schema } from "effect"

export const Parameters = Schema.Struct({
  result: Schema.String.annotate({
    description:
      "The final result of the task: a concise summary of what was accomplished, presented to the user as the task outcome.",
  }),
})

// Agents with finishTool enabled (the default) may only end their turn by
// calling this tool — the session loop resists end-of-stream stops until it
// completes. The tool is otherwise a pure signal; the loop exits on completion.
export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.succeed({
          title: "Task completed",
          output: params.result,
          metadata: {},
        }),
    }
  }),
)
