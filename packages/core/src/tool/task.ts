export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task"

const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "Short description of the task" }),
  prompt: Schema.String.annotate({ description: "Task prompt for the subagent" }),
  subagent_type: Schema.String.annotate({ description: "Type of subagent to delegate to" }),
})
const Output = Schema.String

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Delegate a task to a subagent. The subagent type determines which agent handles the task. Permission is checked against the subagent type.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.subagent_type],
                sessionID: context.sessionID,
                agent: context.agent,
                source: {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                },
              })
              return `Delegated to ${input.subagent_type}: ${input.description}`
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                // Permission errors become ToolFailure with message
                const message = error instanceof Error ? error.message : String(error)
                return new ToolFailure({ message })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
