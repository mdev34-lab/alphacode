export * as CompressTool from "./compress"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { ContextManager } from "../context/manager"
import { makeLocationNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "compress"

export const Input = Schema.Struct({
  focus: Schema.String.pipe(Schema.optional).annotate({
    description: "What the summary must preserve, for example 'the auth refactor decisions and the failing test'",
  }),
  keep_recent_turns: Schema.Int.pipe(Schema.optional).annotate({
    description: "How many recent assistant turns to leave untouched. Defaults to the configured protection window.",
  }),
  start_message_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional explicit first message of the range to compress",
  }),
  end_message_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional explicit last message of the range to compress",
  }),
})

export const Output = Schema.Struct({
  compressed: Schema.Boolean,
  detail: Schema.String,
  messages: Schema.Int,
  tokens_saved: Schema.Int,
  /** First message the resulting summary actually covers. */
  start_message_id: Schema.String.pipe(Schema.optional),
  /** Last message the resulting summary actually covers. */
  end_message_id: Schema.String.pipe(Schema.optional),
  /** Protected messages inside the requested range that stayed verbatim. */
  protected_messages_kept: Schema.Int.pipe(Schema.optional),
})
export type Output = typeof Output.Type

const DESCRIPTION = [
  "Compress a completed section of this conversation into a compact technical summary.",
  "",
  "Use this when an earlier part of the task is finished and no longer needs to be present verbatim:",
  "long exploratory reads, superseded tool output, or a subtask that is done and verified.",
  "",
  "The summary replaces those messages in the context sent to the model on later turns. The session",
  "history itself is never modified, and recent turns, the active plan, and the current todo state are",
  "always kept verbatim. Compressing an already compressed range folds the earlier summary into the new",
  "one instead of discarding it.",
  "",
  "Describe what matters in `focus` so the summary keeps it. Compression costs one model call, so",
  "compress a substantial finished section rather than a couple of messages.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const context = yield* ContextManager.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          // Compression bookkeeping must survive every reduction strategy.
          contextPolicy: { protect: true, deduplicate: false },
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.detail }],
          execute: (input, ctx) =>
            Effect.gen(function* () {
              const result = yield* context.compress({
                sessionID: ctx.sessionID,
                reason: "model",
                focus: input.focus,
                keepRecentTurns: input.keep_recent_turns,
                startMessageID:
                  input.start_message_id === undefined ? undefined : SessionMessage.ID.make(input.start_message_id),
                endMessageID:
                  input.end_message_id === undefined ? undefined : SessionMessage.ID.make(input.end_message_id),
              })
              if ("failure" in result)
                return {
                  compressed: false,
                  detail: explain(result.failure),
                  messages: 0,
                  tokens_saved: 0,
                }
              // Report the range that was actually summarized: protected messages inside the
              // requested range stay verbatim, so the block can be narrower than what was asked for.
              const kept =
                result.excludedMessages === 0
                  ? ""
                  : ` ${result.excludedMessages} protected message${result.excludedMessages === 1 ? "" : "s"} in that range stayed verbatim.`
              return {
                compressed: true,
                detail:
                  `Compressed ${result.block.sourceMessageCount} messages (${result.block.startMessageID} to ${result.block.endMessageID}) into a ${result.block.summaryTokenCount} token summary.` +
                  kept,
                messages: result.block.sourceMessageCount,
                tokens_saved: result.tokensSaved,
                start_message_id: result.block.startMessageID,
                end_message_id: result.block.endMessageID,
                protected_messages_kept: result.excludedMessages,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to compress the conversation" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

const explain = (failure: ContextManager.CompressFailure) => {
  if (failure === "disabled") return "Dynamic compression is disabled for this session."
  if (failure === "no-model") return "No model is available to produce a summary right now."
  if (failure === "invalid-range") return "That message range does not exist in this session."
  if (failure === "protected-range") return "That range overlaps recent turns, which stay verbatim."
  if (failure === "empty-range")
    return "Nothing outside the protected recent window and the protected messages in that range is worth compressing yet."
  if (failure === "timeout") return "The summary model did not answer within the compression time budget."
  return "The summary model did not return a usable summary; the context is unchanged."
}

export const node = makeLocationNode({
  name: "tool/compress",
  layer,
  deps: [ToolRegistry.node, ContextManager.node],
})
