/**
 * Pure helpers for manipulating `WebChatThread` values.
 *
 * The adapter mutates the shared thread object it owns (the one persisted by
 * the `ThreadStore`) and re-persists it after each turn. Helpers are in-place
 * mutators that return the thread for chaining.
 */
import type { WebChatMessage, WebChatThread } from "./types"

/** Last message in the thread (the head), or `undefined` when empty. */
export function head(thread: WebChatThread): WebChatMessage | undefined {
  return thread.messages[thread.messages.length - 1]
}

/** The most recent message carrying provider state (the chain anchor). */
export function lastAnchored(thread: WebChatThread): WebChatMessage | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]
    if (message.providerState) return message
  }
  return undefined
}

export function append(thread: WebChatThread, message: WebChatMessage): WebChatThread {
  thread.messages.push(message)
  thread.updatedAt = Date.now()
  return thread
}

export function upsert(thread: WebChatThread, message: WebChatMessage): WebChatThread {
  const index = thread.messages.findIndex((entry) => entry.id === message.id)
  if (index === -1) thread.messages.push(message)
  else thread.messages[index] = message
  thread.updatedAt = Date.now()
  return thread
}

export function byId(thread: WebChatThread, messageId: string): WebChatMessage | undefined {
  return thread.messages.find((message) => message.id === messageId)
}

/** Truncate the thread after `messageId` (removes the message and all
 * descendants). Used by fork/compaction seeds. */
export function truncateAfter(thread: WebChatThread, messageId: string): WebChatThread {
  const index = thread.messages.findIndex((message) => message.id === messageId)
  if (index === -1) return thread
  thread.messages = thread.messages.slice(0, index + 1)
  thread.updatedAt = Date.now()
  return thread
}

/** Remove the message with `messageId` (used by in-place edits that rewrite
 * the node rather than truncating the tree). */
export function removeById(thread: WebChatThread, messageId: string): WebChatThread {
  thread.messages = thread.messages.filter((message) => message.id !== messageId)
  thread.updatedAt = Date.now()
  return thread
}

export function flattenText(message: WebChatMessage): string {
  const parts: string[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text) parts.push(part.text)
    } else if (part.type === "tool-call") {
      parts.push(`<tool-call ${part.name}>`)
    } else if (part.type === "tool-result") {
      parts.push(`<tool-result ${part.name}>`)
    }
  }
  return parts.join("\n")
}