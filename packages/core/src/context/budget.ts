export * as ContextBudget from "./budget"

import { Token } from "../util/token"
import { ContextDeduplicate } from "./deduplicate"
import { ContextProtection } from "./protection"
import { ContextPurgeErrors } from "./purge-errors"
import type { ContextMessage, ProtectionPolicy, Recommendation, Settings, ToolContextPolicy } from "./types"

export const TRUNCATED_MARKER = "[stale tool output truncated to fit the provider payload budget]"
export const TODO_MARKER = "[superseded todo snapshot pruned to fit the provider payload budget]"
const TRUNCATE_KEEP = 400

export const tokens = (messages: readonly ContextMessage[]) => Token.estimate(JSON.stringify(messages))

/**
 * Serialized size of canonical context material.
 *
 * An estimate of the provider payload, deliberately: the wire body is protocol-specific and only
 * exists once a request has been built. Planning uses this; enforcement uses `ContextManager.payload`.
 */
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")

/**
 * Token and byte size of one message list from a single serialization.
 *
 * `prepare` runs on every turn and needs both numbers for both the canonical and the reduced list.
 * Serializing a large history is the dominant cost of the whole pipeline, so it is done once per
 * list instead of once per metric.
 */
export const measure = (messages: readonly ContextMessage[]) => {
  const serialized = JSON.stringify(messages) ?? ""
  return { tokens: Token.estimate(serialized), bytes: Buffer.byteLength(serialized, "utf8") }
}

/**
 * Everything a provider request carries besides the conversation itself.
 *
 * Utilization measured from history alone is a lie: the system prompt and the tool definitions are
 * resent on every turn and are frequently larger than the recent conversation. The caller that owns
 * the request — the session runner — declares them here so the budget bands describe the real
 * prompt envelope instead of just its message list.
 *
 * This is an estimate, not the wire payload: it measures the canonical inputs a request is built
 * from, not the provider-native body they are lowered into. That is the right trade for planning
 * decisions, which have to be made before the request exists. Enforcement of the hard byte ceiling
 * measures the serialized body itself — see `ContextManager.payload`.
 */
export interface Envelope {
  /** System prompt parts, exactly as the request will send them. */
  readonly system?: unknown
  /** Tool definitions advertised to the provider for this turn. */
  readonly tools?: unknown
  /** Request material that is neither projected history nor tools, such as the max-steps message. */
  readonly extra?: unknown
}

export interface EnvelopeCost {
  readonly tokens: number
  readonly bytes: number
}

export const emptyEnvelope: EnvelopeCost = { tokens: 0, bytes: 0 }

/** Estimate the non-history part of a provider request the same way history itself is estimated. */
export const envelope = (input: Envelope | undefined): EnvelopeCost => {
  if (input === undefined) return emptyEnvelope
  const serialized = JSON.stringify([input.system ?? [], input.tools ?? [], input.extra ?? []])
  return { tokens: Token.estimate(serialized), bytes: Buffer.byteLength(serialized, "utf8") }
}

/**
 * Map context utilization onto a policy action.
 *
 * Large context is not by itself a problem, so the low bands deliberately do nothing. Only the top
 * band forces a reduction, and even then compression is preferred over dropping content.
 */
export const recommend = (utilization: number, settings: Settings["compression"]): Recommendation => {
  if (!Number.isFinite(utilization) || utilization <= 0) return "none"
  if (utilization < settings.minContext) return "none"
  const span = Math.max(settings.maxContext - settings.minContext, 0)
  if (utilization < settings.minContext + span * 0.6) return "normal"
  if (utilization < settings.maxContext) return "nudge"
  if (utilization < settings.maxContext + (1 - settings.maxContext) * 0.33) return "prefer"
  return "mandatory"
}

export interface ReduceInput {
  readonly messages: readonly ContextMessage[]
  readonly policy: ProtectionPolicy
  readonly protection: ContextProtection.Resolved
  readonly toolPolicies?: Readonly<Record<string, ToolContextPolicy>>
  readonly limit: number
}

export interface ReduceResult {
  readonly messages: readonly ContextMessage[]
  readonly steps: readonly string[]
  /** True when the *estimated* payload fits. Authoritative sizing is `ContextManager.payload`. */
  readonly within: boolean
  /** True when only an LLM-backed compression can still bring the payload under the limit. */
  readonly needsCompression: boolean
}

/**
 * Deterministic last-resort reduction for a payload that is expected to exceed a provider limit.
 *
 * Steps run in a fixed order from cheapest to most destructive and stop as soon as the payload
 * fits. Dropping messages is genuinely last and never touches protected content.
 *
 * This is an approximate pre-pass, not the enforcement point. It measures canonical messages with
 * `bytes` while the provider receives a protocol-specific body built from them, so `within: true`
 * means "expected to fit", not "will fit". The request is measured for real, after lowering, by
 * `ContextManager.payload`, and that is the check the runner refuses to send against. Keeping the
 * estimate here is deliberate: reduction has to choose what to keep before a request exists, and
 * lowering every candidate payload through the provider protocol to compare sizes would cost far
 * more than the ladder saves.
 */
export const reduce = (input: ReduceInput): ReduceResult => {
  const steps: string[] = []
  let messages = input.messages
  const done = () => bytes(messages) <= input.limit
  if (done()) return { messages, steps, within: true, needsCompression: false }

  const duplicates = ContextDeduplicate.plan(messages, {
    policy: input.policy,
    protection: input.protection,
    toolPolicies: input.toolPolicies,
    force: true,
  })
  if (duplicates.size > 0) {
    messages = ContextDeduplicate.apply(messages, duplicates)
    steps.push("deduplicate")
    if (done()) return { messages, steps, within: true, needsCompression: false }
  }

  const errors = ContextPurgeErrors.plan(messages, {
    policy: input.policy,
    toolPolicies: input.toolPolicies,
    turns: 0,
    force: true,
  })
  if (errors.size > 0) {
    messages = ContextPurgeErrors.apply(messages, errors)
    steps.push("purge-errors")
    if (done()) return { messages, steps, within: true, needsCompression: false }
  }

  const collapsed = collapseScaffolding(messages, input)
  if (collapsed !== messages) {
    messages = collapsed
    steps.push("collapse-scaffolding")
    if (done()) return { messages, steps, within: true, needsCompression: false }
  }

  const todos = collapseTodos(messages, input)
  if (todos !== messages) {
    messages = todos
    steps.push("collapse-todos")
    if (done()) return { messages, steps, within: true, needsCompression: false }
  }

  const dropped = dropOldestBeforeRecentWindow(messages, input)
  if (dropped.messages !== messages) {
    messages = dropped.messages
    steps.push("drop-oldest")
  }
  return { messages, steps, within: done(), needsCompression: !done() || dropped.exhausted }
}

/** Truncate oversized completed outputs of stale, unprotected tool calls. */
const collapseScaffolding = (messages: readonly ContextMessage[], input: ReduceInput) => {
  let changed = false
  const result = messages.map((message) => {
    if (message.type !== "assistant") return message
    let touched = false
    const content = message.content.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part
      if (input.protection.callIDs.has(part.id)) return part
      if (ContextProtection.isProtectedTool(part.name, input.policy, input.toolPolicies)) return part
      const text = part.state.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")
      if (text.length <= TRUNCATE_KEEP * 2) return part
      changed = true
      touched = true
      return {
        ...part,
        state: {
          status: "completed" as const,
          input: part.state.input,
          structured: {},
          content: [
            {
              type: "text" as const,
              text: `${text.slice(0, TRUNCATE_KEEP)}\n${TRUNCATED_MARKER}\n${text.slice(-TRUNCATE_KEEP)}`,
            },
          ],
        },
      }
    })
    return touched ? { ...message, content } : message
  })
  return changed ? result : messages
}

/** Keep only the newest todo snapshot; earlier ones are entirely superseded. */
const collapseTodos = (messages: readonly ContextMessage[], input: ReduceInput) => {
  const snapshots = messages.flatMap((message, index) =>
    message.type === "assistant" && index < input.protection.recentFrom
      ? message.content.flatMap((part) =>
          part.type === "tool" && part.name === "todowrite" && part.state.status === "completed" ? [part.id] : [],
        )
      : [],
  )
  const stale = new Set(snapshots.slice(0, -1))
  if (stale.size === 0) return messages
  return messages.map((message) => {
    if (message.type !== "assistant") return message
    if (!message.content.some((part) => part.type === "tool" && stale.has(part.id))) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || !stale.has(part.id) || part.state.status !== "completed") return part
        return {
          ...part,
          state: {
            status: "completed" as const,
            input: part.state.input,
            structured: {},
            content: [{ type: "text" as const, text: TODO_MARKER }],
          },
        }
      }),
    }
  })
}

/**
 * Drop unprotected messages, oldest first, until the payload fits.
 *
 * This deliberately only ever considers the prefix *before* the protected recent window: dropping
 * a recent turn is worse than sending an oversized request, because the model would answer a
 * question it can no longer see. So "until it fits" is a best effort, not a guarantee — do not
 * "fix" this by letting the loop run to the end of the list.
 *
 * `exhausted` reports that the eligible prefix ran out with the payload still too large, which
 * means the caller must compress or fail the turn rather than silently sending it.
 */
const dropOldestBeforeRecentWindow = (messages: readonly ContextMessage[], input: ReduceInput) => {
  // Eligibility is decided against the original positions, because removing a message shifts every
  // later index left and would otherwise walk the boundary into the protected window.
  const droppable = messages
    .slice(0, input.protection.recentFrom)
    .filter((message) => !input.protection.messageIDs.has(message.id))
  const kept = [...messages]
  for (const message of droppable) {
    if (bytes(kept) <= input.limit) return { messages: kept, exhausted: false }
    kept.splice(kept.indexOf(message), 1)
  }
  return { messages: kept, exhausted: bytes(kept) > input.limit }
}
