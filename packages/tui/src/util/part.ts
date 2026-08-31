import type { Part } from "@opencode-ai/sdk/v2"

function searchPart(parts: Part[], id: string) {
  let left = 0
  let right = parts.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = parts[middle].id
    if (value === id) return { found: true, index: middle }
    if (value < id) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

// A live `message.part.updated` event carries the durable part snapshot. For
// streamed parts that snapshot can lag the deltas already applied to the
// store: a reasoning block's "started" row is persisted with an empty `text`
// before any `message.part.delta` events arrive, and that stale row can be
// replayed or resynced while the part is still streaming (long reasoning runs,
// SSE reconnects, or heavy CPU load delaying the durable event). Replacing the
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

// Pure transition for the `message.part.updated` handler: the next part list
// for a message after a durable snapshot arrives. Preserves streamed text when
// the snapshot is stale/empty, inserts new parts in id order, and seeds the
// list when none exists yet.
export function applyPartUpdated(parts: Part[] | undefined, incoming: Part): Part[] {
  if (!parts) return [incoming]
  const result = searchPart(parts, incoming.id)
  const next = parts.slice()
  if (result.found) {
    next[result.index] = mergePartText(parts[result.index], incoming)
    return next
  }
  next.splice(result.index, 0, incoming)
  return next
}

// Pure transition for the `message.part.delta` handler: appends a streamed
// delta to the named field, returning undefined when there is no part to
// append to (matching the live-only handler's early return).
export function applyPartDelta(
  parts: Part[] | undefined,
  partID: string,
  field: string,
  delta: string,
): Part[] | undefined {
  if (!parts) return undefined
  const result = searchPart(parts, partID)
  if (!result.found) return undefined
  const next = parts.slice()
  const current = next[result.index] as Record<string, unknown>
  const updated = { ...current } as Record<string, unknown>
  updated[field] = ((current[field] as string | undefined) ?? "") + delta
  next[result.index] = updated as Part
  return next
}
