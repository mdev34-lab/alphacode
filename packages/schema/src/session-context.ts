export * as SessionContext from "./session-context"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"
import { SessionMessage } from "./session-message"

/** How urgently the context compiler wants the conversation to shrink. */
export const Recommendation = Schema.Literals(["none", "normal", "nudge", "prefer", "mandatory"])
export type Recommendation = typeof Recommendation.Type

export const Stats = Schema.Struct({
  rawTokens: NonNegativeInt,
  preparedTokens: NonNegativeInt,
  /** Tokens spent on the system prompt, tool definitions and other non-history request material. */
  overheadTokens: NonNegativeInt,
  tokensSaved: NonNegativeInt,
  compressionCount: NonNegativeInt,
  compressedMessages: NonNegativeInt,
  deduplicatedMessages: NonNegativeInt,
  purgedErrors: NonNegativeInt,
  utilization: Schema.Finite,
  limit: NonNegativeInt.pipe(optional),
  recommendation: Recommendation,
  /**
   * The serialized request is expected to exceed `context.payload_bytes`.
   *
   * Deliberately separate from `recommendation`, which describes context-window pressure only: a
   * session can be at 12% of its token window and still be over the byte ceiling.
   */
  payloadOverBudget: Schema.Boolean,
}).annotate({ identifier: "SessionContext.Stats" })
export interface Stats extends Schema.Schema.Type<typeof Stats> {}

/** One compressed conversation range, as persisted for the session. */
export const Block = Schema.Struct({
  id: Schema.String,
  startMessageID: SessionMessage.ID,
  endMessageID: SessionMessage.ID,
  focus: Schema.String.pipe(optional),
  sourceMessageCount: NonNegativeInt,
  sourceTokenCount: NonNegativeInt,
  summaryTokenCount: NonNegativeInt,
  nested: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionContext.Block" })
export interface Block extends Schema.Schema.Type<typeof Block> {}

export const Compressed = Schema.Struct({
  status: Schema.Literal("compressed"),
  block: Block,
  /** Protected messages inside the requested range that were kept verbatim instead of summarized. */
  excludedMessages: NonNegativeInt,
  stats: Stats,
}).annotate({ identifier: "SessionContext.Compressed" })

/**
 * Why a compress request did not summarize anything.
 *
 * One literal per `ContextManager.CompressFailure` in core — the public contract stays as typed as
 * the internal state machine, so clients can switch on the reason instead of parsing strings.
 */
export const SkipReason = Schema.Literals([
  "disabled",
  "no-model",
  "empty-range",
  "invalid-range",
  "protected-range",
  "summary-unavailable",
  "timeout",
])
export type SkipReason = typeof SkipReason.Type

export const Skipped = Schema.Struct({
  status: Schema.Literal("skipped"),
  /** Machine-readable cause, for example `protected-range` or `summary-unavailable`. */
  reason: SkipReason,
  stats: Stats,
}).annotate({ identifier: "SessionContext.Skipped" })

export const Outcome = Schema.Union([Compressed, Skipped]).annotate({ identifier: "SessionContext.Outcome" })
export type Outcome = typeof Outcome.Type
