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

export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")

/**
 * Everything a provider request carries besides the conversation itself.
 *
 * Utilization measured from history alone is a lie: the system prompt and the tool definitions are
 * resent on every turn and are frequently larger than the recent conversation. The caller that owns
 * the request — the session runner — declares them here so the budget bands describe the real
 * prompt envelope instead of just its message list.
 */
export interface Envelope {
  /** System prompt blocks, in the order the request will send them. */
  readonly system?: readonly string[]
  /** Tool definitions advertised to the provider for this turn. */
  readonly tools?: unknown
  /** Request-level material that is neither history nor tools, such as the max-steps prompt. */
  readonly extra?: readonly string[]
}

export interface EnvelopeCost {
  readonly tokens: number
  readonly bytes: number
}

export const emptyEnvelope: EnvelopeCost = { tokens: 0, bytes: 0 }

/** Measure the non-history part of a provider request the same way history itself is measured. */
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
  readonly within: boolean
  /** True when only an LLM-backed compression can still bring the payload under the limit. */
  readonly needsCompression: boolean
}

/**
 * Deterministic last-resort reduction for a serialized payload that exceeds a provider byte limit.
 *
 * Steps run in a fixed order from cheapest to most destructive and stop as soon as the payload
 * fits. Dropping messages is genuinely last and never touches protected content.
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

  const dropped = dropOldest(messages, input)
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
 * Remove the oldest unprotected messages, one at a time, until the payload fits.
 *
 * `exhausted` reports that only protected content is left, which means the caller must compress or
 * fail the turn rather than silently sending an oversized request.
 */
const dropOldest = (messages: readonly ContextMessage[], input: ReduceInput) => {
  const kept = [...messages]
  for (let index = 0; index < kept.length; index++) {
    if (bytes(kept) <= input.limit) return { messages: kept, exhausted: false }
    const message = kept[index]!
    if (index >= input.protection.recentFrom) break
    if (input.protection.messageIDs.has(message.id)) continue
    kept.splice(index, 1)
    index--
  }
  return { messages: kept, exhausted: bytes(kept) > input.limit }
}
