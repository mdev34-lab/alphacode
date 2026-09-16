export * as LspTool from "./lsp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"

const Input = Schema.Struct({
  operation: Schema.String.annotate({ description: "LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "Path to the file" }),
  line: Schema.optional(Schema.Number),
  character: Schema.optional(Schema.Number),
  query: Schema.optional(Schema.String),
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
            "Language Server Protocol operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, etc. Requires LSP permission.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                },
              })
              return `LSP ${input.operation} not implemented in this minimal runtime`
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                return new ToolFailure({ message: error instanceof Error ? error.message : String(error) })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
