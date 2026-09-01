export * as ContextInvariants from "./invariants"

import type { SessionMessage } from "../session/message"
import { PREFIX } from "./state"
import type { ContextMessage } from "./types"

/**
 * Message-shape invariants for a prepared context.
 *
 * These are the guard rails that keep dynamic context management from turning into the class of
 * provider failures caused by message-editing plugins: fabricated assistant turns, invented tool
 * calls, and system messages appended after an assistant response.
 *
 * Reducing a *recorded* tool result or a stale failed input is allowed and is the entire point of
 * the subsystem. Inventing assistant content is never allowed.
 */
export const check = (canonical: readonly ContextMessage[], prepared: readonly ContextMessage[]) => {
  const violations: string[] = []
  const source = new Map(canonical.map((message) => [message.id, message]))

  const canonicalAssistants = canonical.filter((message) => message.type === "assistant")
  const preparedAssistants = prepared.filter((message) => message.type === "assistant")
  if (preparedAssistants.length > canonicalAssistants.length)
    violations.push("prepared context contains more assistant messages than the session history")

  for (const message of preparedAssistants) {
    const original = source.get(message.id)
    if (original === undefined || original.type !== "assistant") {
      violations.push(`synthetic assistant message ${message.id}`)
      continue
    }
    violations.push(...assistantViolations(original, message))
  }

  for (const message of prepared) {
    if (source.has(message.id) || message.type === "assistant") continue
    if (message.type === "synthetic" && message.id.startsWith(`msg_${PREFIX}`)) continue
    violations.push(`synthetic ${message.type} message ${message.id}`)
  }

  const systemBefore = canonical.filter((message) => message.type === "system").length
  const systemAfter = prepared.filter((message) => message.type === "system").length
  if (systemAfter > systemBefore) violations.push("prepared context appended a system message")

  return violations
}

/** Throw for callers that treat a violated invariant as a defect, such as tests. */
export const assertNoSyntheticAssistantContent = (
  canonical: readonly ContextMessage[],
  prepared: readonly ContextMessage[],
) => {
  const violations = check(canonical, prepared)
  if (violations.length > 0) throw new Error(`Context invariant violated: ${violations.join("; ")}`)
}

const assistantViolations = (original: SessionMessage.Assistant, prepared: SessionMessage.Assistant) => {
  const violations: string[] = []
  const kind = (part: SessionMessage.AssistantContent) => (part.type === "tool" ? `tool:${part.id}` : part.type)
  const shape = (message: SessionMessage.Assistant) => message.content.map(kind).join(",")
  if (shape(original) !== shape(prepared)) violations.push(`assistant message ${prepared.id} changed its content shape`)
  for (const part of prepared.content) {
    const source = original.content.find((item) => kind(item) === kind(part))
    if (source === undefined) continue
    if (part.type === "text" && source.type === "text" && part.text !== source.text)
      violations.push(`assistant message ${prepared.id} rewrote model text`)
    if (part.type === "reasoning" && source.type === "reasoning" && part.text !== source.text)
      violations.push(`assistant message ${prepared.id} rewrote model reasoning`)
    if (part.type !== "tool" || source.type !== "tool") continue
    if (part.name !== source.name) violations.push(`assistant message ${prepared.id} renamed tool call ${part.id}`)
    // Provider-executed calls lower inline into the assistant message, so they stay untouched.
    if (source.provider?.executed === true && JSON.stringify(part.state) !== JSON.stringify(source.state))
      violations.push(`assistant message ${prepared.id} edited a provider-executed tool result`)
  }
  return violations
}
