import type { Part, TextPart, ReasoningPart, ToolState } from "@opencode-ai/sdk/v2"

type PartTime = { start: number; end?: number }

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

function isTextLike(part: Part): part is TextPart | ReasoningPart {
  return part.type === "text" || part.type === "reasoning"
}

// A live `message.part.updated` event carries the durable part snapshot. For
// streamed parts that snapshot can lag the deltas already applied to the
// store: a reasoning block's "started" row is persisted with an empty `text`
// before any `message.part.delta` events arrive, and that stale row can be
// replayed or resynced while the part is still streaming (long reasoning runs,
// SSE reconnects, or heavy CPU load delaying the durable event). Replacing the
// part wholesale would erase already-rendered text, so preserve the streamed
// content when the incoming snapshot has no text of its own.
//
// Merge decision for streamed text: never shorten what is already on screen.
// - incoming has nothing (stale "started" row) → keep the streamed text;
// - incoming has a prefix of the streamed text (durable row persisted between
//   two deltas) → keep the longer streamed text;
// - incoming is equal to or longer than the streamed text (authoritative
//   snapshot, or a reconnect that persisted more than was replayed) → adopt.
export function mergePartText(current: Part | undefined, incoming: Part): Part {
  if (current && isTextLike(current) && isTextLike(incoming)) {
    const text = incoming.text.length >= current.text.length ? incoming.text : current.text
    if (text !== incoming.text) return { ...incoming, text }
  }
  return incoming
}

// `time` is monotonic during a turn: `end` is written once, by the durable
// row, and a stale replay must not erase it or move it backwards. `start`
// carries no such risk and follows the durable snapshot.
function mergeTime(current: PartTime | undefined, incoming: PartTime | undefined): PartTime | undefined {
  if (!incoming) return current
  const end =
    incoming.end === undefined ? current?.end : Math.max(incoming.end, current?.end ?? Number.NEGATIVE_INFINITY)
  return { start: incoming.start, ...(end === undefined ? {} : { end }) }
}

// A snapshot parsed by the processor records `metadata.interrupted` when a
// tool call is cancelled. A later (stale) replay of an earlier row must not
// clear it, or an interrupted tool renders as a plain failure.
function mergeMetadata(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (incoming === undefined && current === undefined) return undefined
  const preserved = current?.interrupted === true ? { interrupted: true } : {}
  if (incoming === undefined) return current
  return { ...incoming, ...preserved }
}

// Tool state progresses pending → running → completed/error. A durable
// snapshot replayed out of order (SSE reconnect is the common case) can carry
// an older status; adopting it would make a finished tool render as running
// again, and the identity-preserving merge would keep that wrong state alive.
// The same applies to `output` (never shrink what is rendered) and `error`
// (a terminal field must not be cleared by a stale replay).
const TOOL_STATUS_RANK: Record<ToolState["status"], number> = {
  pending: 0,
  running: 1,
  completed: 2,
  error: 2,
}

function mergeToolState(current: ToolState, incoming: ToolState): ToolState {
  const status = TOOL_STATUS_RANK[incoming.status] < TOOL_STATUS_RANK[current.status] ? current.status : incoming.status
  const merged: Record<string, unknown> = { ...incoming, status }
  const currentMeta = (current as { metadata?: Record<string, unknown> }).metadata
  const incomingMeta = (incoming as { metadata?: Record<string, unknown> }).metadata
  const metadata = mergeMetadata(currentMeta, incomingMeta)
  if (metadata !== undefined) merged.metadata = metadata
  const time = mergeTime((current as { time?: PartTime }).time, (incoming as { time?: PartTime }).time)
  if (time !== undefined) merged.time = time
  const currentOutput = (current as { output?: string }).output
  const incomingOutput = (incoming as { output?: string }).output
  if (incomingOutput !== undefined || currentOutput !== undefined) {
    merged.output =
      incomingOutput !== undefined && (currentOutput === undefined || incomingOutput.length >= currentOutput.length)
        ? incomingOutput
        : currentOutput
  }
  const incomingError = (incoming as { error?: string }).error
  const currentError = (current as { error?: string }).error
  const error = incomingError ?? currentError
  if (error !== undefined) merged.error = error
  const incomingTitle = (incoming as { title?: string }).title
  const currentTitle = (current as { title?: string }).title
  const title = incomingTitle ?? currentTitle
  if (title !== undefined) merged.title = title
  return merged as ToolState
}

// Replaces the content of `target` with `source` while keeping `target`'s
// identity. Only used when the part's *type* itself changes (schema evolution;
// a streaming part never changes type), where an in-place payload swap is the
// only identity-preserving option.
function replaceInPlace(target: Part, source: Part) {
  const destination = target as Record<string, unknown>
  for (const key of Object.keys(destination)) delete destination[key]
  for (const key of Object.keys(source)) destination[key] = (source as Record<string, unknown>)[key]
}

// Merges `source` into `target` in place, keeping `target`'s identity.
//
// The transcript renders parts inside a keyed `<For>` (Solid's `For` keys by
// object identity), so replacing the part object for every streamed delta
// would dispose and re-create the streaming component on each token: the
// markdown/syntax tree is rebuilt from scratch, layout re-runs, and local
// state (e.g. an expanded reasoning block) resets — the aggressive redraw and
// flicker. Mutating the existing part in place keeps the mount stable while
// the changed field's reactive node (Solid store) still fires.
//
// The merge is explicit about the fields with streaming semantics instead of
// copying the snapshot blindly:
// - text/reasoning `text`: already resolved by `mergePartText` (never shorten);
// - `time.end`: never regresses;
// - tool `state`: status/output/error/title/metadata guards above;
// - every other field (including fields a newer schema may add) is adopted
//   from the snapshot; fields absent from the snapshot are kept, never deleted,
//   so an older durable row cannot drop newer data.
export function mergePartInPlace(target: Part, source: Part): Part {
  if (target.type !== source.type) {
    replaceInPlace(target, source)
    return target
  }

  if (isTextLike(target) && isTextLike(source)) {
    target.text = source.text
  }
  if (target.type === "tool" && source.type === "tool") {
    target.state = mergeToolState(target.state, source.state)
  }

  const currentTime = (target as { time?: PartTime }).time
  const incomingTime = (source as { time?: PartTime }).time
  const mergedTime = mergeTime(currentTime, incomingTime)
  if (mergedTime !== undefined) (target as { time?: PartTime }).time = mergedTime

  const destination = target as Record<string, unknown>
  const incoming = source as Record<string, unknown>
  for (const key of Object.keys(incoming)) {
    if (key === "type" || key === "id" || key === "sessionID" || key === "messageID") continue
    if (key === "text" || key === "state" || key === "time") continue
    destination[key] = incoming[key]
  }
  return target
}

// Transition for the `message.part.updated` handler: merges the durable
// snapshot into the existing part in place (preserving object identity and
// streamed content; see `mergePartInPlace`), inserts missing parts in id
// order, and seeds the list when none exists yet. Operates on a Solid store
// draft (or a plain array in tests); pass it to `setStore(..., produce(...))`
// so mutations are applied and notified.
export function applyPartUpdated(parts: Part[] | undefined, incoming: Part): Part[] {
  if (!parts) return [incoming]
  const result = searchPart(parts, incoming.id)
  if (result.found) {
    const current = parts[result.index]
    mergePartInPlace(current, mergePartText(current, incoming))
    return parts
  }
  parts.splice(result.index, 0, incoming)
  return parts
}

// Transition for the `message.part.delta` handler: appends a streamed delta to
// the named field of the existing part, preserving the part's object identity
// (see `mergePartInPlace`), and returns the same list. Returns undefined when
// there is no part to append to (matching the live-only handler's early
// return). Deltas are string appends — the wire protocol only streams `text` —
// so a non-string target (e.g. `metadata`, `time`, `state`) is a protocol
// violation and is left untouched rather than corrupting the part.
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
  const current = part[field]
  if (current !== undefined && typeof current !== "string") return parts
  part[field] = ((current as string | undefined) ?? "") + delta
  return parts
}
