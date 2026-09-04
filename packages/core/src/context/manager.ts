export * as ContextManager from "./manager"

import { LLMClient, SystemPart, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
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
import { ToolRegistry } from "../tool/registry"
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
  /**
   * Non-history material the same provider request will carry: system prompt, tool definitions and
   * any request-level extras. Budgeting without it under-reports utilization on every turn.
   */
  readonly envelope?: ContextBudget.Envelope
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
  /**
   * Tool context policies for this session. Defaults to the ones the last prepared turn declared,
   * so a tool that declares itself protected is protected from compression as well as from pruning.
   */
  readonly toolPolicies?: Readonly<Record<string, ContextTypes.ToolContextPolicy>>
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
  | "timeout"

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
  /**
   * Exact size of the request that would go on the wire, against the configured byte ceiling.
   *
   * Everything else in this module estimates, because reduction decisions have to be made before a
   * request exists. Enforcement does not get to estimate: the request is lowered into its
   * provider-native body and that serialization is what is measured. A request whose body cannot be
   * built is reported as unmeasured and not within budget, because "we could not check" is not
   * permission to send.
   */
  readonly payload: (request: LLMRequest, sessionID?: SessionSchema.ID) => Effect.Effect<PayloadSize>
}

/** Keys under which the major provider bodies carry their conversation turns. */
const BODY_MESSAGE_KEYS = ["messages", "contents", "input"] as const

/**
 * The non-conversation cost of a provider-native body: its serialized size minus the portion that
 * holds the conversation turns.
 *
 * Calibration must learn the envelope — system prompt, tool definitions, provider keys — and
 * nothing else. Deriving it as "wire minus canonical messages" would also absorb whatever the
 * lowering adds *inside* the conversation (which scales with content, not with the envelope), so
 * the first oversized request would teach planning to flinch at everything that survives. A body
 * whose conversation part cannot be found is not calibrated from.
 */
const wireEnvelopeBytes = (body: unknown, bytes: number) => {
  if (typeof body !== "object" || body === null) return undefined
  for (const key of BODY_MESSAGE_KEYS) {
    const value = (body as Record<string, unknown>)[key]
    if (Array.isArray(value)) return bytes - Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
  }
  return undefined
}

export interface PayloadSize {
  /** Serialized size of the provider-native body, or a lower bound when `measured` is false. */
  readonly bytes: number
  readonly limit: number | undefined
  readonly within: boolean
  /**
   * Whether `bytes` came from the real provider body.
   *
   * False in the two cases where no measurement happened: no ceiling is configured, so nothing had
   * to be measured (`within` is true, there is nothing to enforce), or the body could not be built,
   * so the ceiling could not be enforced (`within` is false, because an unknown size is not
   * permission to send).
   */
  readonly measured: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ContextManager") {}

/** Failures that cost a summarization round trip, so repeating them immediately costs it again. */
const COSTLY_FAILURES = new Set<CompressFailure>(["timeout", "summary-unavailable", "no-model"])

/** How many preparations skip automatic compression after such a failure. */
const BACKOFF_PREPARATIONS = 3

export const GUIDANCE = `Context management:
When a completed portion of this conversation is no longer needed verbatim, call the compress tool
to replace it with a compact technical summary. Compression preserves the session history; it only
reduces what is resent to the model. Prefer compressing finished work over losing recent context.`

/**
 * The last preparation decision for a session.
 *
 * This is deliberately not a cache of the prepared projection: the message list is different on
 * every turn, so a projection cached from the previous turn could never be reused, and reusing one
 * would be the exact failure this subsystem exists to avoid — sending a model a context that no
 * longer matches the session. What is worth remembering is the *decision*: the reduction plan, the
 * numbers derived from it, and the revision it belongs to, so that repeated reads (`stats`, the TUI
 * indicator, a client polling between turns) are free, and so the revision only moves when the plan
 * genuinely changes, which keeps provider prompt caching effective.
 *
 * Recompiling from scratch each turn is affordable by design; `script/context-benchmark.ts` reports
 * the cost of a preparation with nothing to reduce.
 */
interface Cached {
  readonly revision: number
  readonly stats: ContextTypes.ContextStats
  readonly plan: string
  readonly utilization: number
  readonly limit: number | undefined
  readonly recommendation: ContextTypes.Recommendation
  readonly payloadOverBudget: boolean
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service
    const models = yield* SessionRunnerModel.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const settings = resolveSettings(yield* (yield* Config.Service).entries())
    const cache = new Map<SessionSchema.ID, Cached>()
    // Last envelope a runner declared for a session, so a stats request that arrives between turns
    // still reports utilization against the whole prompt rather than the message list alone.
    const envelopes = new Map<SessionSchema.ID, ContextBudget.EnvelopeCost>()
    /**
     * The non-conversation cost of the session's last accepted wire body, as measured by
     * `payload` (body size minus its conversation portion).
     *
     * The planning estimate serializes `[system, tools, extra]` as JSON, which is a different
     * representation than the provider-native body — it can be off in either direction. Every
     * accepted measurement converges planning toward wire reality: preparation budgets against
     * the larger of the estimate and this observed envelope, so an optimistic gap about request
     * overhead survives at most until the session's first accepted request, never for its
     * lifetime. The hard gate stays the final arbiter regardless.
     */
    const measuredOverhead = new Map<SessionSchema.ID, number>()
    // Tool-declared context policies, remembered per session for callers that do not materialize
    // tools themselves, such as the compress tool and the manual /compress command.
    const policies = new Map<SessionSchema.ID, Readonly<Record<string, ContextTypes.ToolContextPolicy>>>()
    /**
     * Preparations left to skip before automatic compression is attempted again, per session.
     *
     * Automatic compression runs inside the turn the user is waiting on, so a summarizer that is
     * down, throttled or slower than the compression budget must cost that latency once, not on
     * every turn until the session ends. Only failures that cost a round trip — or that say no
     * model is available — arm this; a structurally impossible range is free and is retried
     * immediately.
     */
    const backoff = new Map<SessionSchema.ID, number>()
    let revision = 0

    const envelopeFor = (input: PrepareInput, observe: boolean) => {
      if (input.envelope === undefined) return envelopes.get(input.sessionID) ?? ContextBudget.emptyEnvelope
      const cost = ContextBudget.envelope(input.envelope)
      if (!observe) envelopes.set(input.sessionID, cost)
      return cost
    }

    const passthrough = (
      input: PrepareInput,
      limit: number | undefined,
      overhead: ContextBudget.EnvelopeCost,
    ): ContextTypes.PreparedContext => {
      const tokens = ContextBudget.tokens(input.messages) + overhead.tokens
      return {
        sessionID: input.sessionID,
        purpose: input.purpose,
        messages: input.messages,
        stats: {
          ...ContextTypes.emptyStats,
          rawTokens: tokens,
          preparedTokens: tokens,
          overheadTokens: overhead.tokens,
        },
        recommendation: "none",
        utilization: limit === undefined || limit <= 0 ? 0 : tokens / limit,
        limit,
        overBudget: false,
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

    /**
     * Compile one prepared context.
     *
     * `observe` runs the identical pipeline with none of its bookkeeping: no lifecycle event, no
     * stale-block deletion, no remembered envelope or tool policies, no cache write and no revision
     * bump. `stats` uses it so that reading context usage can never change context behaviour.
     */
    const prepareOnce = Effect.fnUntraced(function* (input: PrepareInput, observe = false) {
      const limit = usableLimit(input)
      const overhead = envelopeFor(input, observe)
      if (input.toolPolicies && !observe) policies.set(input.sessionID, input.toolPolicies)
      if (ContextTypes.isolated(input.purpose)) return passthrough(input, limit, overhead)
      if (!observe)
        yield* events.publish(SessionEvent.Context.Preparing, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          messageCount: input.messages.length,
          rawTokens: ContextBudget.tokens(input.messages) + overhead.tokens,
          limit,
        })

      const blocks = settings.compression.enabled ? yield* ContextState.list(db, input.sessionID) : []
      const protection = ContextProtection.resolve(input.messages, {
        policy: settings.protection,
        toolPolicies: input.toolPolicies,
      })
      const placed = ContextPlaceholder.apply(input.sessionID, input.messages, blocks, protection.messageIDs)
      if (placed.stale.length > 0 && !observe)
        yield* ContextState.remove(
          db,
          placed.stale.map((block) => block.id),
        )
      // Overlapping ranges cannot both describe what they replace, so the compiler merged them.
      // Persist that decision instead of re-deriving it every turn: the widened block becomes the
      // authoritative range and the blocks folded into it are marked absorbed.
      if (placed.merged.length > 0 && !observe)
        yield* Effect.forEach(placed.merged, (item) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("context.prepare.overlap-normalized", {
              sessionID: input.sessionID,
              blockID: item.block.id,
              absorbed: item.absorbed,
              startMessageID: item.block.startMessageID,
              endMessageID: item.block.endMessageID,
            })
            yield* ContextState.widen(db, item.block)
            yield* ContextState.absorb(db, item.absorbed, item.block.id)
          }),
        )

      const rawTokens = ContextBudget.measure(input.messages).tokens + overhead.tokens
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
      if (cached?.plan !== plan && !observe) revision++

      const reduced = ContextPurgeErrors.apply(ContextDeduplicate.apply(placed.messages, duplicates), errors)
      // The byte ceiling covers the whole request, so the envelope spends from it too — but watch
      // the units. This comparison adds canonical-history JSON bytes to a serialization overhead,
      // while the wire carries a provider-native body built by route.body.from. The two
      // representations differ, so this decision can be off in either direction, and automatic
      // compression (below) fires from this estimate too. Two safeguards keep the gap bounded:
      // planning uses the larger of the estimate and the overhead actually observed on the wire
      // for this session, and the only authoritative measurement is `payload`, run by the runner
      // on the lowered request — an estimate that is still optimistic converts into exactly one
      // overflow compaction and a retried turn, never into an oversized request on the wire.

      const plannedOverheadBytes = Math.max(overhead.bytes, measuredOverhead.get(input.sessionID) ?? 0)
      const payloadBudget =
        settings.payloadBytes === undefined ? undefined : Math.max(settings.payloadBytes - plannedOverheadBytes, 1)
      const measured = ContextBudget.measure(reduced)
      const reduction =
        payloadBudget === undefined || measured.bytes <= payloadBudget
          ? undefined
          : ContextBudget.reduce({
              messages: reduced,
              policy: settings.protection,
              protection,
              toolPolicies: input.toolPolicies,
              limit: payloadBudget,
            })
      const gated = reduction?.messages ?? reduced
      // The ladder is a ceiling, not a suggestion. When even protected content alone exceeds it,
      // the only remaining lever is compression, so say so instead of sending an oversized request.
      const overBudget = reduction !== undefined && !reduction.within
      // One serialization serves the cache, the prepped-token accounting and the debug line.
      const gatedMeasure = reduction === undefined ? measured : ContextBudget.measure(gated)
      if (reduction !== undefined)
        yield* Effect.logDebug("context.prepare.payload", {
          sessionID: input.sessionID,
          steps: reduction.steps,
          within: reduction.within,
          limit: payloadBudget,
          bytes: gatedMeasure.bytes + plannedOverheadBytes,
        })

      const violations = ContextInvariants.check(input.messages, gated)
      if (violations.length > 0) {
        // Context management must never make a session unusable: fall back to canonical history.
        yield* Effect.logWarning("context.prepare.invariant", { sessionID: input.sessionID, violations })
        return passthrough(input, limit, overhead)
      }

      // Only a ladder pass changes the list, so the measurement above is reused when it did not run.
      const preparedTokens = gatedMeasure.tokens + overhead.tokens
      const stats: ContextTypes.ContextStats = {
        rawTokens,
        preparedTokens,
        overheadTokens: overhead.tokens,
        tokensSaved: Math.max(rawTokens - preparedTokens, 0),
        compressionCount: placed.blocks.length,
        compressedMessages: placed.compressedMessages,
        deduplicatedMessages: duplicates.size,
        purgedErrors: errors.size,
      }
      const utilization = limit === undefined ? 0 : preparedTokens / limit
      // `recommendation` describes context-window pressure and nothing else. A payload that is too
      // large in bytes is reported as `overBudget`, separately, because the two are independent:
      // conflating them would tell a client the context window is critical when it is nearly empty.
      const preparedRecommendation = ContextBudget.recommend(utilization, settings.compression)
      if (!observe)
        cache.set(input.sessionID, {
          revision,
          stats,
          plan,
          utilization,
          limit,
          recommendation: preparedRecommendation,
          payloadOverBudget: overBudget,
        })
      return {
        sessionID: input.sessionID,
        purpose: input.purpose,
        messages: gated,
        stats,
        recommendation: preparedRecommendation,
        utilization,
        limit,
        overBudget,
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
        overheadTokens: prepared.stats.overheadTokens,
        tokensSaved: prepared.stats.tokensSaved,
        compressionCount: prepared.stats.compressionCount,
        compressedMessages: prepared.stats.compressedMessages,
        deduplicatedMessages: prepared.stats.deduplicatedMessages,
        purgedErrors: prepared.stats.purgedErrors,
        utilization: prepared.utilization,
        limit: prepared.limit,
        recommendation: prepared.recommendation,
        payloadOverBudget: prepared.overBudget,
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
        toolPolicies: input.toolPolicies ?? policies.get(input.sessionID),
      })
      const requestedStart =
        input.startMessageID === undefined ? 0 : messages.findIndex((message) => message.id === input.startMessageID)
      const requestedEnd =
        input.endMessageID === undefined
          ? protection.recentFrom - 1
          : messages.findIndex((message) => message.id === input.endMessageID)
      if (requestedStart < 0 || requestedEnd < 0) return { failure: "invalid-range" as const }
      if (requestedEnd >= protection.recentFrom) return { failure: "protected-range" as const }

      // Compression must never leave two blocks partially overlapping: the projection would have to
      // choose between them and one summary would become unreachable. A new range therefore grows
      // to cover every block it intersects, and absorbs all of them.
      const existing = yield* ContextState.list(db, input.sessionID)
      const index = ContextPlaceholder.positions(messages)
      const located = existing.flatMap((block) => {
        const range = ContextPlaceholder.locate(index, block)
        return range === undefined ? [] : [range]
      })
      let start = requestedStart
      let end = requestedEnd
      let grew = true
      while (grew) {
        grew = false
        for (const range of located) {
          if (range.start > end || range.end < start) continue
          if (range.start >= start && range.end <= end) continue
          start = Math.min(start, range.start)
          end = Math.max(end, range.end)
          grew = true
        }
      }
      // Growing into the protected window is not allowed, so the caller is told instead.
      if (end >= protection.recentFrom) return { failure: "protected-range" as const }
      const covered = located.filter((range) => range.start >= start && range.end <= end).map((range) => range.block)

      // Protected messages inside the requested range stay verbatim: they are excluded from the
      // summary input and re-emitted around the placeholder. The caller is told how many, because
      // the compressed block then covers less than the range that was asked for.
      const requested = messages.slice(start, end + 1)
      const selected = requested.filter((message) => !protection.messageIDs.has(message.id))
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
      // Automatic compression runs inside the turn the user is waiting on, so the summary request
      // is bounded: a slow provider degrades to an uncompressed turn instead of a stalled one.
      const answered = yield* ContextCompressor.summarize(llm, {
        model,
        http: input.http,
        messages: selected,
        focus: input.focus,
        nested: covered.map((block) => block.summary),
      }).pipe(Effect.timeoutOption(Duration.millis(settings.compression.timeoutMillis)))
      if (Option.isNone(answered)) {
        yield* fail(input.sessionID, "the summary model did not answer within the compression time budget")
        return { failure: "timeout" as const }
      }
      const summary = answered.value
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
        excludedMessages: requested.length - selected.length,
      }
    })

    const fail = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, reason: string) {
      yield* events.publish(SessionEvent.Context.CompressionFailed, {
        sessionID,
        timestamp: yield* DateTime.now,
        reason,
      })
    })

    const payload = Effect.fnUntraced(function* (request: LLMRequest, sessionID?: SessionSchema.ID) {
      const limit = settings.payloadBytes
      // Nothing to enforce: no ceiling is configured, so the body is never built and nothing is
      // measured. `measured` says exactly that rather than claiming a size that was never taken.
      if (limit === undefined) return { bytes: 0, limit, within: true, measured: false } satisfies PayloadSize
      const route = request.model.route
      const body = yield* route.body.from(request).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const serialized =
        body === undefined
          ? undefined
          : yield* Schema.encodeEffect(Schema.fromJsonString(route.body.schema))(body).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
      if (serialized === undefined) {
        // The body could not be built, so the wire size is unknown. This is the hard enforcement
        // point, and an unknown size cannot be declared within budget: the request is treated
        // exactly like an oversized one, which gives the runner its recovery attempt and otherwise
        // refuses the turn. The canonical material only provides a lower bound for the report.
        const estimate = Buffer.byteLength(JSON.stringify([request.system, request.messages, request.tools]), "utf8")
        yield* Effect.logWarning("context.payload.unmeasurable", {
          provider: request.model.provider,
          model: request.model.id,
          estimate,
          limit,
        })
        return { bytes: estimate, limit, within: false, measured: false } satisfies PayloadSize
      }
      const bytes = Buffer.byteLength(serialized, "utf8")
      const within = bytes <= limit
      if (sessionID !== undefined && within) {
        // Feed the measurement back into planning. Only an accepted request calibrates: a rejected
        // one's envelope would teach planning to flinch at content that is gone by the retried
        // turn. Planning still takes the larger of estimate and observation, so this only ever
        // moves conservative.
        const observed = wireEnvelopeBytes(body, bytes)
        if (observed !== undefined) measuredOverhead.set(sessionID, observed)
      }
      return { bytes, limit, within, measured: true } satisfies PayloadSize
    })

    const resolveModel = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return undefined
      return yield* models.resolve(session).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    })

    /**
     * Rebuild everything the runner's request carries besides the projected history — the agent
     * system prompt, the context guidance and the tool definitions — without preparing a turn.
     *
     * The very first stats request of a session arrives before any turn exists and therefore
     * before any envelope can have been observed; judging utilization from the message list alone
     * would report an empty context the first real turn immediately disproves, which is exactly
     * when a client reads stats to initialize its UI. Two request parts are still not knowable
     * here: the epoch baseline, which only counts once it exists (it joins on the first prepared
     * turn), and the max-steps trailing message, which depends on the step counter.
     */
    const baselineEnvelope = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return undefined
      const agent = yield* agents.select(session.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const materialized = yield* tools
        .materialize(agent?.info?.permissions)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const system = [agent?.info?.system, settings.compression.enabled ? GUIDANCE : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(SystemPart.make)
      return { system, tools: materialized?.definitions ?? [] } satisfies ContextBudget.Envelope
    })

    /**
     * A payload the deterministic ladder could not fit is logged, and surfaces to clients on the
     * prepared event as `payloadOverBudget`.
     *
     * It is deliberately not a `compression.failed` event: nothing failed to compress. Reporting a
     * byte-ladder outcome as a failed summarization would make plugins and clients treat ordinary
     * payload pressure as a broken compression operation.
     */
    const reportOverBudget = Effect.fnUntraced(function* (prepared: ContextTypes.PreparedContext) {
      if (!prepared.overBudget) return
      yield* Effect.logWarning("context.prepare.over-budget", {
        sessionID: prepared.sessionID,
        preparedTokens: prepared.stats.preparedTokens,
        limit: settings.payloadBytes,
      })
    })

    /**
     * Prepare, and escalate to compression at most once.
     *
     * The worst case a turn can pay here is one summarization request before the real request. The
     * runner may add one native compaction on top when the measured payload is still too large, and
     * that retry prepares with `automatic` off, so the ladder cannot recurse: at most two internal
     * requests are ever inserted ahead of the model call the user is waiting for.
     */
    const prepare = Effect.fn("ContextManager.prepare")(function* (input: PrepareInput) {
      const first = yield* prepareOnce(input)
      const skips = backoff.get(input.sessionID) ?? 0
      // Two independent reasons to compress on our own: the token window is critically full, or the
      // request is too large in bytes. They are checked separately rather than folded into one
      // value, so neither condition has to be described in the other's terms to be acted on.
      const attempt =
        (first.recommendation === "mandatory" || first.overBudget) &&
        input.automatic === true &&
        settings.compression.enabled &&
        settings.compression.automatic
      if (attempt && skips > 0) {
        backoff.set(input.sessionID, skips - 1)
        yield* Effect.logDebug("context.prepare.compression-backoff", {
          sessionID: input.sessionID,
          remaining: skips - 1,
        })
      }
      if (!attempt || skips > 0) {
        yield* reportOverBudget(first)
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
        if (compressed.failure !== undefined && COSTLY_FAILURES.has(compressed.failure))
          backoff.set(input.sessionID, BACKOFF_PREPARATIONS)
        yield* reportOverBudget(first)
        yield* publishPrepared(first)
        return first
      }
      backoff.delete(input.sessionID)
      const second = yield* prepareOnce(input)
      yield* reportOverBudget(second)
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
            payloadOverBudget: cached.payloadOverBudget,
          }
        // Nothing prepared yet this run: compile the current history once so a client asking for
        // context usage before the first turn still gets real numbers — against the envelope the
        // first turn will actually send, not against history alone. Observing only — a stats
        // request must not decide anything for the next turn.
        const prepared = yield* prepareOnce(
          {
            sessionID,
            messages: yield* SessionHistory.load(db, sessionID).pipe(Effect.orDie),
            purpose: "agent-turn",
            model: yield* resolveModel(sessionID),
            envelope: yield* baselineEnvelope(sessionID),
          },
          true,
        )
        return {
          ...prepared.stats,
          utilization: prepared.utilization,
          limit: prepared.limit,
          recommendation: prepared.recommendation,
          payloadOverBudget: prepared.overBudget,
        }
      }),
      invalidate: Effect.fn("ContextManager.invalidate")(function* (sessionID) {
        cache.delete(sessionID)
        backoff.delete(sessionID)
        yield* ContextState.reset(db, sessionID)
      }),
      guidance: () => (settings.compression.enabled ? GUIDANCE : undefined),
      payload,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionStore.node,
    SessionRunnerModel.node,
    Config.node,
  ],
})
