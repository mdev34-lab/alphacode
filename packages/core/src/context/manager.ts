export * as ContextManager from "./manager"

import { LLMClient, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionHistory } from "../session/history"
import type { SessionMessage } from "../session/message"
import { SessionRunnerModel } from "../session/runner/model"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ContextBudget } from "./budget"
import { ContextCompressor } from "./compressor"
import { ContextDeduplicate } from "./deduplicate"
import { ContextInvariants } from "./invariants"
import { ContextPlaceholder } from "./placeholders"
import { ContextProtection } from "./protection"
import { ContextPurgeErrors } from "./purge-errors"
import { ContextState } from "./state"
import { ContextTypes } from "./types"
import { settings as resolveSettings } from "./settings"

export interface PrepareInput {
  readonly sessionID: SessionSchema.ID
  readonly messages: readonly ContextTypes.ContextMessage[]
  readonly purpose: ContextTypes.Purpose
  readonly model?: Model
  readonly toolPolicies?: Readonly<Record<string, ContextTypes.ToolContextPolicy>>
  readonly http?: LLMRequest["http"]
  /** Output tokens the provider turn reserves; subtracted from the usable context window. */
  readonly reserve?: number
  /** Allow the compiler to run an automatic compression when utilization becomes critical. */
  readonly automatic?: boolean
}

export interface CompressInput {
  readonly sessionID: SessionSchema.ID
  readonly reason: ContextTypes.CompressionReason
  readonly messages?: readonly ContextTypes.ContextMessage[]
  readonly startMessageID?: SessionMessage.ID
  readonly endMessageID?: SessionMessage.ID
  /** Assistant turns to leave verbatim when no explicit end boundary is given. */
  readonly keepRecentTurns?: number
  readonly focus?: string
  readonly model?: Model
  readonly http?: LLMRequest["http"]
}

export type CompressFailure =
  | "disabled"
  | "no-model"
  | "empty-range"
  | "invalid-range"
  | "protected-range"
  | "summary-unavailable"

export interface Interface {
  readonly prepare: (input: PrepareInput) => Effect.Effect<ContextTypes.PreparedContext>
  readonly compress: (
    input: CompressInput,
  ) => Effect.Effect<ContextTypes.CompressionResult | { readonly failure: CompressFailure }>
  readonly stats: (sessionID: SessionSchema.ID) => Effect.Effect<ContextTypes.ContextSnapshot>
  /** Drop cached reduction plans and boundaries, for example after native compaction. */
  readonly invalidate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Stable system-prompt guidance describing the context tools, or undefined when disabled. */
  readonly guidance: () => string | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ContextManager") {}

export const GUIDANCE = `Context management:
When a completed portion of this conversation is no longer needed verbatim, call the compress tool
to replace it with a compact technical summary. Compression preserves the session history; it only
reduces what is resent to the model. Prefer compressing finished work over losing recent context.`

interface Cached {
  readonly revision: number
  readonly stats: ContextTypes.ContextStats
  readonly plan: string
  readonly utilization: number
  readonly limit: number | undefined
  readonly recommendation: ContextTypes.Recommendation
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service
    const models = yield* SessionRunnerModel.Service
    const settings = resolveSettings(yield* (yield* Config.Service).entries())
    const cache = new Map<SessionSchema.ID, Cached>()
    let revision = 0

    const passthrough = (input: PrepareInput, limit: number | undefined): ContextTypes.PreparedContext => {
      const tokens = ContextBudget.tokens(input.messages)
      return {
        sessionID: input.sessionID,
        purpose: input.purpose,
        messages: input.messages,
        stats: { ...ContextTypes.emptyStats, rawTokens: tokens, preparedTokens: tokens },
        recommendation: "none",
        utilization: limit === undefined || limit <= 0 ? 0 : tokens / limit,
        limit,
        blocks: [],
        revision,
      }
    }

    const usableLimit = (input: PrepareInput) => {
      const limit = input.model?.route.defaults.limits?.context
      if (limit === undefined || limit <= 0) return undefined
      const reserve = input.reserve ?? input.model?.route.defaults.limits?.output ?? 0
      return Math.max(limit - reserve, 1)
    }

    const prepareOnce = Effect.fnUntraced(function* (input: PrepareInput) {
      const limit = usableLimit(input)
      if (ContextTypes.isolated(input.purpose)) return passthrough(input, limit)
      yield* events.publish(SessionEvent.Context.Preparing, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        messageCount: input.messages.length,
        rawTokens: ContextBudget.tokens(input.messages),
        limit,
      })

      const blocks = settings.compression.enabled ? yield* ContextState.list(db, input.sessionID) : []
      const protection = ContextProtection.resolve(input.messages, {
        policy: settings.protection,
        toolPolicies: input.toolPolicies,
      })
      const placed = ContextPlaceholder.apply(input.sessionID, input.messages, blocks, protection.messageIDs)
      if (placed.stale.length > 0)
        yield* ContextState.remove(
          db,
          placed.stale.map((block) => block.id),
        )

      const rawTokens = ContextBudget.tokens(input.messages)
      // Both plans are deterministic and monotonic: a call that is superseded, or an error input
      // that is stale, stays that way. The request prefix therefore only changes when a genuinely
      // new duplicate or newly stale failure appears, which keeps provider prompt caching useful.
      const duplicates = settings.deduplication.enabled
        ? ContextDeduplicate.plan(placed.messages, {
            policy: settings.protection,
            protection,
            toolPolicies: input.toolPolicies,
          })
        : new Set<string>()
      const errors = settings.purgeErrors.enabled
        ? ContextPurgeErrors.plan(placed.messages, {
            policy: settings.protection,
            toolPolicies: input.toolPolicies,
            turns: settings.purgeErrors.turns,
          })
        : new Set<string>()
      const plan = [placed.blocks.map((block) => block.id), [...duplicates].toSorted(), [...errors].toSorted()]
        .map((items) => items.join(","))
        .join("|")
      const cached = cache.get(input.sessionID)
      if (cached?.plan !== plan) revision++

      const reduced = ContextPurgeErrors.apply(ContextDeduplicate.apply(placed.messages, duplicates), errors)
      const gated =
        settings.payloadBytes === undefined || ContextBudget.bytes(reduced) <= settings.payloadBytes
          ? reduced
          : ContextBudget.reduce({
              messages: reduced,
              policy: settings.protection,
              protection,
              toolPolicies: input.toolPolicies,
              limit: settings.payloadBytes,
            }).messages

      const violations = ContextInvariants.check(input.messages, gated)
      if (violations.length > 0) {
        // Context management must never make a session unusable: fall back to canonical history.
        yield* Effect.logWarning("context.prepare.invariant", { sessionID: input.sessionID, violations })
        return passthrough(input, limit)
      }

      const preparedTokens = ContextBudget.tokens(gated)
      const stats: ContextTypes.ContextStats = {
        rawTokens,
        preparedTokens,
        tokensSaved: Math.max(rawTokens - preparedTokens, 0),
        compressionCount: placed.blocks.length,
        compressedMessages: placed.compressedMessages,
        deduplicatedMessages: duplicates.size,
        purgedErrors: errors.size,
      }
      const utilization = limit === undefined ? 0 : preparedTokens / limit
      const preparedRecommendation = ContextBudget.recommend(utilization, settings.compression)
      cache.set(input.sessionID, { revision, stats, plan, utilization, limit, recommendation: preparedRecommendation })
      return {
        sessionID: input.sessionID,
        purpose: input.purpose,
        messages: gated,
        stats,
        recommendation: preparedRecommendation,
        utilization,
        limit,
        blocks: placed.blocks,
        revision,
      } satisfies ContextTypes.PreparedContext
    })

    const publishPrepared = Effect.fnUntraced(function* (prepared: ContextTypes.PreparedContext) {
      if (ContextTypes.isolated(prepared.purpose)) return
      yield* events.publish(SessionEvent.Context.Prepared, {
        sessionID: prepared.sessionID,
        timestamp: yield* DateTime.now,
        rawTokens: prepared.stats.rawTokens,
        preparedTokens: prepared.stats.preparedTokens,
        tokensSaved: prepared.stats.tokensSaved,
        compressionCount: prepared.stats.compressionCount,
        compressedMessages: prepared.stats.compressedMessages,
        deduplicatedMessages: prepared.stats.deduplicatedMessages,
        purgedErrors: prepared.stats.purgedErrors,
        utilization: prepared.utilization,
        limit: prepared.limit,
        recommendation: prepared.recommendation,
      })
    })

    const compress = Effect.fn("ContextManager.compress")(function* (input: CompressInput) {
      if (!settings.compression.enabled) return { failure: "disabled" as const }
      const messages = input.messages ?? (yield* SessionHistory.load(db, input.sessionID).pipe(Effect.orDie))
      const protection = ContextProtection.resolve(messages, {
        policy: {
          ...settings.protection,
          recentTurns: input.keepRecentTurns ?? settings.protection.recentTurns,
        },
      })
      const start =
        input.startMessageID === undefined ? 0 : messages.findIndex((message) => message.id === input.startMessageID)
      const end =
        input.endMessageID === undefined
          ? protection.recentFrom - 1
          : messages.findIndex((message) => message.id === input.endMessageID)
      if (start < 0 || end < 0) return { failure: "invalid-range" as const }
      if (end >= protection.recentFrom) return { failure: "protected-range" as const }
      const selected = messages.slice(start, end + 1).filter((message) => !protection.messageIDs.has(message.id))
      if (selected.length < 2 || start > end) return { failure: "empty-range" as const }

      yield* events.publish(SessionEvent.Context.Compressing, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        reason: input.reason,
        startMessageID: selected[0]!.id,
        endMessageID: selected.at(-1)!.id,
        messageCount: selected.length,
      })
      const model = input.model ?? (yield* resolveModel(input.sessionID))
      if (!model) {
        yield* fail(input.sessionID, "no model is available for compression")
        return { failure: "no-model" as const }
      }
      const existing = yield* ContextState.list(db, input.sessionID)
      const covered = existing.filter((block) => {
        const blockStart = messages.findIndex((message) => message.id === block.startMessageID)
        const blockEnd = messages.findIndex((message) => message.id === block.endMessageID)
        return blockStart >= start && blockEnd >= 0 && blockEnd <= end
      })
      const summary = yield* ContextCompressor.summarize(llm, {
        model,
        http: input.http,
        messages: selected,
        focus: input.focus,
        nested: covered.map((block) => block.summary),
      })
      if (summary === undefined) {
        yield* fail(input.sessionID, "the summary model returned no usable summary")
        return { failure: "summary-unavailable" as const }
      }
      const block = ContextCompressor.block({
        id: ContextState.createID(),
        messages: selected,
        summary,
        focus: input.focus,
        nested: covered.flatMap((item) => [item.id, ...item.nested]),
        createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
      })
      yield* ContextState.insert(db, input.sessionID, block)
      yield* ContextState.absorb(
        db,
        covered.map((item) => item.id),
        block.id,
      )
      cache.delete(input.sessionID)
      yield* events.publish(SessionEvent.Context.Compressed, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        blockID: block.id,
        startMessageID: block.startMessageID,
        endMessageID: block.endMessageID,
        reason: input.reason,
        sourceMessageCount: block.sourceMessageCount,
        sourceTokenCount: block.sourceTokenCount,
        summaryTokenCount: block.summaryTokenCount,
      })
      return {
        block,
        tokensSaved: Math.max(block.sourceTokenCount - block.summaryTokenCount, 0),
      }
    })

    const fail = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, reason: string) {
      yield* events.publish(SessionEvent.Context.CompressionFailed, {
        sessionID,
        timestamp: yield* DateTime.now,
        reason,
      })
    })

    const resolveModel = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return undefined
      return yield* models.resolve(session).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    })

    const prepare = Effect.fn("ContextManager.prepare")(function* (input: PrepareInput) {
      const first = yield* prepareOnce(input)
      if (
        first.recommendation !== "mandatory" ||
        input.automatic !== true ||
        !settings.compression.enabled ||
        !settings.compression.automatic
      ) {
        yield* publishPrepared(first)
        return first
      }
      const compressed = yield* compress({
        sessionID: input.sessionID,
        reason: "auto",
        messages: input.messages,
        model: input.model,
        http: input.http,
      })
      if ("failure" in compressed) {
        yield* publishPrepared(first)
        return first
      }
      const second = yield* prepareOnce(input)
      yield* publishPrepared(second)
      return second
    })

    return Service.of({
      prepare,
      compress,
      stats: Effect.fn("ContextManager.stats")(function* (sessionID) {
        const cached = cache.get(sessionID)
        if (cached)
          return {
            ...cached.stats,
            utilization: cached.utilization,
            limit: cached.limit,
            recommendation: cached.recommendation,
          }
        // Nothing prepared yet this run: compile the current history once so a client asking for
        // context usage before the first turn still gets real numbers.
        const prepared = yield* prepareOnce({
          sessionID,
          messages: yield* SessionHistory.load(db, sessionID).pipe(Effect.orDie),
          purpose: "agent-turn",
          model: yield* resolveModel(sessionID),
        })
        return {
          ...prepared.stats,
          utilization: prepared.utilization,
          limit: prepared.limit,
          recommendation: prepared.recommendation,
        }
      }),
      invalidate: Effect.fn("ContextManager.invalidate")(function* (sessionID) {
        cache.delete(sessionID)
        yield* ContextState.reset(db, sessionID)
      }),
      guidance: () => (settings.compression.enabled ? GUIDANCE : undefined),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, llmClient, SessionStore.node, SessionRunnerModel.node, Config.node],
})
