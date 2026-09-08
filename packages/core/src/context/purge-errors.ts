export * as ContextPurgeErrors from "./purge-errors"

import { ContextProtection } from "./protection"
import type { ContextMessage, ProtectionPolicy, ToolContextPolicy } from "./types"

export const MARKER = "[input purged after error]"

/**
 * Inputs below this size are left alone. Purging them saves almost nothing while still changing the
 * request prefix, which costs provider prompt-cache hits.
 */
export const MIN_BYTES = 256

export interface Options {
  readonly policy: ProtectionPolicy
  readonly toolPolicies?: Readonly<Record<string, ToolContextPolicy>>
  /**
   * Assistant turns a failed input is retained for. The byte-budget fallback passes zero, but even
   * that never reaches into the protected recent window: the boundary below is the tighter of this
   * retention window and `policy.recentTurns`. Protection is not suspended under payload pressure;
   * a fallback that cannot purge within those rules escalates instead.
   */
  readonly turns: number
}

/**
 * Select failed tool calls whose original input is stale.
 *
 * A failure stays useful long after its input does: the model needs the tool name, the error, and a
 * short diagnostic, not the 500 KB script that produced it.
 */
export const plan = (messages: readonly ContextMessage[], options: Options) => {
  const boundary = Math.min(
    ContextProtection.recentWindow(messages, options.turns),
    ContextProtection.recentWindow(messages, options.policy.recentTurns),
  )
  const selected = new Set<string>()
  messages.forEach((message, index) => {
    if (message.type !== "assistant" || index >= boundary) return
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "error") continue
      if (ContextProtection.isProtectedTool(part.name, options.policy, options.toolPolicies)) continue
      if (JSON.stringify(part.state.input).length < MIN_BYTES) continue
      selected.add(part.id)
    }
  })
  return selected
}

/** Replace the input of every selected failed call while keeping its diagnostic intact. */
export const apply = (messages: readonly ContextMessage[], purged: ReadonlySet<string>): readonly ContextMessage[] => {
  if (purged.size === 0) return messages
  return messages.map((message) => {
    if (message.type !== "assistant") return message
    if (!message.content.some((part) => part.type === "tool" && purged.has(part.id))) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || !purged.has(part.id) || part.state.status !== "error") return part
        return { ...part, state: { ...part.state, input: { purged: MARKER } } }
      }),
    }
  })
}
