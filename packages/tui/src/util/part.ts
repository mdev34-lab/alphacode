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

// Copies every field of `merged` onto `target`, keeping `target`'s identity.
// The transcript renders parts inside a keyed `<For>` (Solid's `For` keys by
// object identity), so replacing the part object for every streamed delta
// would dispose and re-create the streaming component on each token: the
// markdown/syntax tree is rebuilt from scratch, layout re-runs, and local
// state (e.g. an expanded reasoning block) resets — the aggressive redraw and
// flicker. Mutating the existing part in place keeps the mount stable while
// the changed field's reactive node still fires.
function mergeInto(target: Part, merged: Part) {
  const destination = target as Record<string, unknown>
  const source = merged as Record<string, unknown>
  for (const key of Object.keys(source)) destination[key] = source[key]
}

// Transition for the `message.part.updated` handler: merges the durable
// snapshot into the existing part in place (preserving object identity and
// streamed text), inserts missing parts in id order, and seeds the list when
// none exists yet. Operates on a Solid store draft (or a plain array in
// tests); pass it to `setStore(..., produce(...))` so mutations are applied
// and notified.
export function applyPartUpdated(parts: Part[] | undefined, incoming: Part): Part[] {
  if (!parts) return [incoming]
  const result = searchPart(parts, incoming.id)
  if (result.found) {
    mergeInto(parts[result.index], mergePartText(parts[result.index], incoming))
    return parts
  }
  parts.splice(result.index, 0, incoming)
  return parts
}

// Transition for the `message.part.delta` handler: appends a streamed delta to
// the named field of the existing part, preserving the part's object identity
// (see `mergeInto`), and returns the same list. Returns undefined when there
// is no part to append to (matching the live-only handler's early return).
export function applyPartDelta(
  parts: Part[] | undefined,
  partID: string,
  field: string,
  delta: string,
): Part[] | undefined {
  if (!parts) return undefined
  const result = searchPart(parts, partID)
  if (!result.found) return undefined
  const part = parts[result.index] as Record<string, unknown>
  part[field] = ((part[field] as string | undefined) ?? "") + delta
  return parts
}
