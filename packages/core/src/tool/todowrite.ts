export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

const TODO_DESCRIPTION = [
  "Create and maintain a structured task list for the current coding session. This is your primary execution-control mechanism, not just a checklist.",
  "",
  "One todo = one coherent unit of work that can be executed and marked complete. Avoid broad phases like 'Update model handling'; prefer specific verifiable units like 'Trace model-selection flow', 'Implement pending model state', 'Add model-switch test'.",
  "Complex tasks should naturally produce longer plans (10-16 items is normal for substantial work); simple tasks remain simple.",
  "",
  "Execution discipline (critical):",
  "1. Select next todo",
  "2. Work ONLY on that item (multiple reads/searches allowed for that one unit)",
  "3. Verify it is actually complete",
  "4. Mark it completed IMMEDIATELY",
  "5. Select next todo",
  "Keep exactly one in_progress at a time. Do not batch unrelated work or mark multiple independent items complete at once unless they were genuinely completed as one indivisible operation.",
  "Todo state must reflect reality: don't mark before verification, don't leave completed work in_progress, don't use updates as retrospective bookkeeping. When new work is discovered, update the plan.",
  "Finish provides a safety net that closes any remaining open todos as cancelled, but you must still explicitly complete items during execution.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: TODO_DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update todos" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionTodo.node],
})
