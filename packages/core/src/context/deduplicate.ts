export * as ContextDeduplicate from "./deduplicate"

import type { SessionMessage } from "../session/message"
import { ContextProtection } from "./protection"
import type { ContextMessage, ProtectionPolicy, ToolContextPolicy } from "./types"

export const MARKER = "[Duplicate tool output pruned: an identical call is repeated later in this conversation]"

export interface Options {
  readonly policy: ProtectionPolicy
  readonly protection: ContextProtection.Resolved
  readonly toolPolicies?: Readonly<Record<string, ToolContextPolicy>>
}

/**
 * Select superseded duplicate tool results.
 *
 * Only the newest result of a repeated `name(arguments)` pair stays verbatim in the prepared
 * context; earlier identical calls keep their call record but lose their output. Canonical history
 * is never touched.
 */
export const plan = (messages: readonly ContextMessage[], options: Options) => {
  const seen = new Map<string, string[]>()
  const sizes = new Map<string, number>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (!ContextProtection.isDeduplicable(part.name, options.policy, options.toolPolicies)) continue
      const key = signature(part)
      seen.set(key, [...(seen.get(key) ?? []), part.id])
      sizes.set(part.id, JSON.stringify(part.state.content).length)
    }
  }
  // The newest occurrence of a signature always survives, including when it sits inside the
  // protected recent window; protection only means a call never loses its own output. That rule
  // has no override: the byte-budget fallback prunes less aggressively, never more protected
  // content — when nothing protected-free remains, the caller escalates instead.
  return new Set(
    Array.from(seen.values())
      .flatMap((ids) => ids.slice(0, -1))
      .filter((id) => !options.protection.callIDs.has(id))
      // Replacing a tiny output with the marker would grow the request instead of shrinking it.
      .filter((id) => (sizes.get(id) ?? 0) > MARKER.length),
  )
}

/** Replace the output of every selected call with a stable marker. */
export const apply = (messages: readonly ContextMessage[], pruned: ReadonlySet<string>): readonly ContextMessage[] => {
  if (pruned.size === 0) return messages
  return messages.map((message) => {
    if (message.type !== "assistant") return message
    if (!message.content.some((part) => part.type === "tool" && pruned.has(part.id))) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || !pruned.has(part.id) || part.state.status !== "completed") return part
        return {
          ...part,
          state: {
            status: "completed" as const,
            input: part.state.input,
            content: [{ type: "text" as const, text: MARKER }],
            structured: {},
          },
        }
      }),
    }
  })
}

export const signature = (tool: SessionMessage.AssistantTool) => `${tool.name}:${stable(tool.state.input)}`

/** Order-independent JSON so `{a,b}` and `{b,a}` count as the same call. */
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}
