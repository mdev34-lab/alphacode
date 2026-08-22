/**
 * Model-facing tool that makes conversation attachments actionable. `list`
 * enumerates the session's materialized attachments (mirroring the
 * `core/attachments` context source, on demand), and `save` copies a chosen
 * attachment into the workspace at an agent-selected path, gated by the `edit`
 * permission through `LocationMutation`.
 */
export * as AttachmentTool from "./attachment"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { AttachmentStore } from "../attachment-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "attachment"

const InventoryItem = Schema.Struct({
  managed_id: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  mime: Schema.String,
  source: Schema.String,
  path: Schema.String.pipe(Schema.optional),
  size: Schema.Number.pipe(Schema.optional),
  unavailable: Schema.Boolean.pipe(Schema.optional),
})

const ListOutput = Schema.Struct({
  action: Schema.Literal("list"),
  attachments: Schema.Array(InventoryItem),
})
const SaveOutput = Schema.Struct({
  action: Schema.Literal("save"),
  resource: Schema.String,
})

const Input = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("list"),
  }),
  Schema.Struct({
    action: Schema.Literal("save"),
    id: Schema.String.annotate({ description: "Attachment id from `attachment list` or the `core/attachments` context" }),
    path: Schema.String.annotate({
      description:
        "Workspace path to save the attachment to. Relative paths resolve within the active Location; external absolute paths require external_directory approval.",
    }),
  }),
).pipe(Schema.toTaggedUnion("action"))

const Output = Schema.Union(ListOutput, SaveOutput)

const inventory = Effect.fn("AttachmentTool.inventory")(function* (sessionID: string) {
  const store = yield* AttachmentStore.Service
  const rows = yield* store.inventory(sessionID)
  return rows.map((row) => ({
    managed_id: row.id,
    name: row.name,
    mime: row.mime,
    source: row.source,
    path: undefined,
    size: row.size,
    unavailable: row.unavailable,
  }))
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* AttachmentStore.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Work with attachments shared in the conversation. `list` enumerates every attachment by its managed_id (name, mime, source, size, and whether it is available); `save` copies a chosen attachment (by id) to a workspace path of your choosing (requires edit permission).",
          input: Input,
          output: Output,
          structured: Output,
          toStructuredOutput: ({ output }) => output,
          toModelOutput: ({ output }) =>
            output.action === "list"
              ? [
                  {
                    type: "text" as const,
                    text:
                      output.attachments.length === 0
                        ? "No attachments in this session."
                        : output.attachments
                            .map(
                              (item) =>
                                 `- managed_id=${item.managed_id} ${item.name ?? ""} (${item.mime}, ${item.unavailable ? "unavailable" : "available"})`,
                            )
                            .join("\n"),
                  },
                ]
              : [{ type: "text" as const, text: `Saved attachment to ${output.resource}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "list") {
                const attachments = yield* inventory(context.sessionID)
                return { action: "list" as const, attachments }
              }
              const result = yield* store
                .copyTo({ sessionID: context.sessionID, agent: context.agent, id: input.id, target: input.path })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              return { action: "save" as const, resource: result.resource }
            }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) })))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/attachment",
  layer,
  deps: [ToolRegistry.node, AttachmentStore.node],
})
