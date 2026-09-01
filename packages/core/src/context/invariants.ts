export * as ContextInvariants from "./invariants"

import type { SessionMessage } from "../session/message"
import { TODO_MARKER, TRUNCATED_MARKER } from "./budget"
import { MARKER as DUPLICATE_MARKER } from "./deduplicate"
import { MARKER as PURGED_MARKER } from "./purge-errors"
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
 * the subsystem, but only through the transformations this module knows about: the duplicate
 * marker, the purged-input marker, the payload-budget truncation and the superseded-todo marker.
 * Any other edit to a tool call, and any invented assistant content, is a violation.
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

  // Reduction may remove and summarize messages, never resequence them.
  const positions = new Map(canonical.map((message, index) => [message.id, index]))
  let cursor = -1
  for (const message of prepared) {
    const position = positions.get(message.id)
    if (position === undefined) continue
    if (position <= cursor) violations.push(`prepared context reordered message ${message.id}`)
    cursor = Math.max(cursor, position)
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
    if (JSON.stringify(part.state) === JSON.stringify(source.state)) continue
    // Provider-executed calls lower inline into the assistant message, so they stay untouched.
    if (source.provider?.executed === true)
      violations.push(`assistant message ${prepared.id} edited a provider-executed tool result`)
    else if (!isAuthorizedReduction(source.state, part.state))
      violations.push(`assistant message ${prepared.id} rewrote tool call ${part.id} outside a known reduction`)
  }
  return violations
}

const text = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content.map((item) => (item.type === "text" ? item.text : "")).join("\n")

/**
 * Recognize the four reductions this subsystem is allowed to perform on a recorded tool call.
 *
 * Everything else — a changed status, a rewritten input on a successful call, a summary written
 * over a real result — is treated as fabrication and sends the turn back to canonical history.
 */
const isAuthorizedReduction = (source: SessionMessage.ToolState, prepared: SessionMessage.ToolState) => {
  if (source.status !== prepared.status) return false
  if (source.status === "error" && prepared.status === "error")
    return (
      JSON.stringify(prepared.input) === JSON.stringify({ purged: PURGED_MARKER }) &&
      JSON.stringify(prepared.error) === JSON.stringify(source.error) &&
      text(prepared.content) === text(source.content)
    )
  if (source.status !== "completed" || prepared.status !== "completed") return false
  if (JSON.stringify(prepared.input) !== JSON.stringify(source.input)) return false
  if (prepared.content.length !== 1 || prepared.content[0]?.type !== "text") return false
  const replacement = prepared.content[0].text
  if (replacement === DUPLICATE_MARKER || replacement === TODO_MARKER) return true
  const [head, tail] = replacement.split(`\n${TRUNCATED_MARKER}\n`)
  if (head === undefined || tail === undefined) return false
  const original = text(source.content)
  return original.startsWith(head) && original.endsWith(tail)
}
