export * as ContextTypes from "./types"

import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

/**
 * Canonical message shape the context compiler operates on.
 *
 * Context management never constructs provider-specific messages. Everything below stays in
 * AlphaCode's own representation until `toLLMMessages` lowers a prepared context for one provider
 * turn.
 */
export type ContextMessage = SessionMessage.Message

/**
 * Why the runtime is talking to a model. Each purpose selects an explicit context policy so
 * internal calls never inherit the user session's dynamic pruning.
 */
export type Purpose = "agent-turn" | "compression" | "title-generation" | "internal-summary" | "other"

/** Purposes that are prepared as isolated context: the compiler passes their messages through. */
export const isolated = (purpose: Purpose) => purpose !== "agent-turn"

/** One compressed contiguous range of canonical history. */
export interface CompressionBlock {
  readonly id: string
  readonly startMessageID: SessionMessage.ID
  readonly endMessageID: SessionMessage.ID
  readonly summary: string
  readonly focus?: string
  readonly createdAt: number
  readonly sourceMessageCount: number
  readonly sourceTokenCount: number
  readonly summaryTokenCount: number
  /** Blocks whose summaries were folded into this one by an overlapping compression. */
  readonly nested: readonly string[]
}

export interface ContextStats {
  readonly rawTokens: number
  readonly preparedTokens: number
  /** Tokens the request spends on the system prompt, tool definitions and other non-history material. */
  readonly overheadTokens: number
  readonly tokensSaved: number
  readonly compressionCount: number
  readonly compressedMessages: number
  readonly deduplicatedMessages: number
  readonly purgedErrors: number
}

export const emptyStats: ContextStats = {
  rawTokens: 0,
  preparedTokens: 0,
  overheadTokens: 0,
  tokensSaved: 0,
  compressionCount: 0,
  compressedMessages: 0,
  deduplicatedMessages: 0,
  purgedErrors: 0,
}

/** Statistics plus the budget view of the session's next provider turn. */
export interface ContextSnapshot extends ContextStats {
  readonly utilization: number
  readonly limit: number | undefined
  readonly recommendation: Recommendation
}

export const emptySnapshot: ContextSnapshot = {
  ...emptyStats,
  utilization: 0,
  limit: undefined,
  recommendation: "none",
}

/**
 * What the budget policy wants for the next provider turn.
 *
 * `nudge` and `prefer` are advisory: they surface through the TUI and the compress tool, never as
 * an extra system or assistant message.
 */
export type Recommendation = "none" | "normal" | "nudge" | "prefer" | "mandatory"

export interface ProtectionPolicy {
  readonly tools: readonly string[]
  readonly filePatterns: readonly string[]
  readonly messageTypes: readonly SessionMessage.Message["type"][]
  readonly recentTurns: number
  readonly userMessages: boolean
}

/** Per-tool context behavior declared by the tool itself. */
export interface ToolContextPolicy {
  readonly deduplicate?: boolean
  readonly protect?: boolean
}

export interface Settings {
  readonly compression: {
    readonly enabled: boolean
    readonly mode: "range"
    readonly automatic: boolean
    readonly minContext: number
    readonly maxContext: number
    /** Upper bound on one summarization request, which runs inside the turn that triggered it. */
    readonly timeoutMillis: number
  }
  readonly deduplication: { readonly enabled: boolean }
  readonly purgeErrors: { readonly enabled: boolean; readonly turns: number }
  readonly protection: ProtectionPolicy
  readonly payloadBytes: number | undefined
}

export interface PreparedContext {
  readonly sessionID: SessionSchema.ID
  readonly purpose: Purpose
  readonly messages: readonly ContextMessage[]
  readonly stats: ContextStats
  readonly recommendation: Recommendation
  /** Fraction of the model context window the prepared context is expected to occupy. */
  readonly utilization: number
  readonly limit: number | undefined
  readonly blocks: readonly CompressionBlock[]
  /** Increments whenever the compiler recomputes its reduction plan for a session. */
  readonly revision: number
}

export interface CompressionResult {
  readonly block: CompressionBlock
  readonly tokensSaved: number
  /** Protected messages inside the requested range that were kept verbatim instead of summarized. */
  readonly excludedMessages: number
}

export type CompressionReason = "model" | "manual" | "auto"
