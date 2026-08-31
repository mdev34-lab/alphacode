import type { Part } from "@opencode-ai/sdk/v2"

// A live `message.part.updated` event carries the durable part snapshot. For
// streamed parts that snapshot can lag the deltas already applied to the
// store: a reasoning block's "started" row is persisted with an empty `text`
// before any `message.part.delta` events arrive, and that stale row can be
// replayed or resynced while the part is still streaming (long reasoning runs,
// SSE reconnects, or high CPU load delaying the durable event). Replacing the
// part wholesale would erase already-rendered text, so preserve the streamed
// content when the incoming snapshot has no text of its own.
export function mergePartText(current: Part | undefined, incoming: Part): Part {
  if (
    current &&
    (current.type === "text" || current.type === "reasoning") &&
    (incoming.type === "text" || incoming.type === "reasoning") &&
    incoming.text.length === 0 &&
    current.text.length > 0
  ) {
    return { ...incoming, text: current.text }
  }
  return incoming
}
