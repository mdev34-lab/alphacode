import { ReviewReport } from "@opencode-ai/core/review-report"

// Review stagnation recovery (issue #171).
//
// A Review subagent can wedge itself restating the same completed review
// across consecutive generations without ever materializing the `finish`
// tool call. Each text-only generation earns the generic finish nudge, the
// next generation reproduces the same text, and the turn never terminates.
//
// This module detects that failure mode deterministically: consecutive
// generations whose model-emitted text is literally identical, with no tool
// activity or other state progress between them. When the run reaches the
// configured threshold the session loop swaps the generic reminder for a
// recovery nudge that directs the model back into the existing `finish`
// path. The heuristic never terminates the review itself and never relaxes
// the finish gating — it only changes which nudge is sent.
//
// The comparison is deliberately literal: no embeddings, no semantic
// similarity, no fuzzy matching, no extra model call. Normalization covers
// only stream artifacts that cannot constitute a meaningful content
// difference (line-ending bytes and empty/structural text parts). Merely
// similar reviews stay different, and any tool call breaks the run.
//
// The nudge is still model-dependent, so a review that ignores it can repeat
// forever while the detector stays true. `reviewStagnationBackstop` is the
// deterministic end of that loop (issue #176): once the identical run
// survives a recovery nudge, and the turn already established a parseable
// report, it hands the session loop the review result to complete with. The
// repeated completion prose is never parsed — the report comes from the
// generation that delivered it.

export const DEFAULT_REPEATS = 2

export function resolveRepeats(input: { repeats?: number }): number {
  return input.repeats === undefined ? DEFAULT_REPEATS : input.repeats
}

export type ReviewStagnationPart = {
  readonly type?: unknown
  readonly text?: unknown
  readonly synthetic?: unknown
  readonly ignored?: unknown
  readonly tool?: unknown
  readonly state?: {
    readonly status?: unknown
  }
}

export type ReviewStagnationMessage = {
  readonly info?: {
    readonly role?: unknown
    readonly summary?: unknown
    readonly error?: unknown
  }
  readonly parts: readonly ReviewStagnationPart[]
}

export type ReviewStagnationState = {
  /** Trailing consecutive identical non-empty generations in the current turn. */
  readonly repeats: number
  /** True once `repeats` reaches a valid threshold (2 or more). */
  readonly stagnated: boolean
}

function messageRole(message: ReviewStagnationMessage) {
  return message.info?.role
}

function isSyntheticUser(message: ReviewStagnationMessage) {
  return (
    messageRole(message) === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.synthetic === true)
  )
}

// Line-ending bytes are a transport artifact: the persisted text may carry
// `\r\n` where another generation carries `\n` without any content
// difference (the verdict scanner already treats them equivalently). Nothing
// else is normalized here — no case folding, no punctuation stripping, no
// whitespace collapsing — so similar reviews never compare equal.
export function normalizeReviewOutput(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

// The model-emitted text of one assistant generation: every text part plus
// the finish summary would be the delivery boundary, but stagnation is only
// evaluated while no terminal finish exists, so this is text parts alone,
// joined the same way the report extractor joins its chunks. Synthetic and
// ignored parts are harness-selected, not model output, and empty parts are
// structural (a trailing empty part carries no content). A generation with
// no significant text is not a restatement of anything.
function generationOutput(message: ReviewStagnationMessage): string | undefined {
  const chunks: string[] = []
  for (const part of message.parts) {
    if (part.type !== "text") continue
    if (part.synthetic === true) continue
    if (part.ignored === true) continue
    if (typeof part.text !== "string") continue
    if (part.text === "") continue
    chunks.push(part.text)
  }
  if (chunks.length === 0) return undefined
  const output = normalizeReviewOutput(chunks.join("\n"))
  if (!/\S/.test(output)) return undefined
  return output
}

function hasToolActivity(message: ReviewStagnationMessage) {
  return message.parts.some((part) => part.type === "tool")
}

function hasCompletedFinish(message: ReviewStagnationMessage) {
  return message.parts.some(
    (part) => part.type === "tool" && part.tool === "finish" && part.state?.status === "completed",
  )
}

// The current user turn: everything after the last real user message.
function currentTurn(messages: readonly ReviewStagnationMessage[]) {
  const start = messages.findLastIndex((message) => messageRole(message) === "user" && !isSyntheticUser(message))
  return start < 0 ? messages : messages.slice(start + 1)
}

// The harness-written recovery nudge, identified by the text the caller sends
// with it: a synthetic user message carrying exactly that text is the nudge,
// so a real user message that happens to repeat the wording never counts.
function carriesRecoveryNudge(message: ReviewStagnationMessage, recovery: string) {
  const nudge = normalizeReviewOutput(recovery)
  return message.parts.some(
    (part) => part.type === "text" && typeof part.text === "string" && normalizeReviewOutput(part.text) === nudge,
  )
}

type ReviewRun = {
  /** Trailing consecutive identical non-empty generations; undefined once a completed finish ends the turn. */
  readonly repeats: number | undefined
  /** Index of the first generation in that run, -1 when there is none. */
  readonly start: number
  /** Index of the recovery nudge sent during this turn, -1 when none was sent. */
  readonly recoveryAt: number
}

// Walk the current user turn and measure the trailing run of literally
// identical generations. Synthetic continuation nudges are skipped rather
// than treated as turn boundaries or progress, so the injected reminders
// between repetitions neither reset the run nor advance it. Any tool call —
// reads included, since reading is the reviewer's work — and any other state
// progress breaks the run, as does a failed generation, an empty one, or a
// new real user message. Summary assistants are harness-generated compaction
// output, not review generations.
function reviewRun(current: readonly ReviewStagnationMessage[], recovery?: string): ReviewRun {
  let text: string | undefined
  let repeats = 0
  let start = -1
  let recoveryAt = -1
  const reset = () => {
    text = undefined
    repeats = 0
    start = -1
  }

  for (const [index, message] of current.entries()) {
    const role = messageRole(message)
    if (role === "user") {
      // Defensive: the slice starts after the last real user message, so a
      // real one here only happens if the caller passed a wider window.
      if (isSyntheticUser(message)) {
        if (recovery !== undefined && carriesRecoveryNudge(message, recovery)) recoveryAt = index
        continue
      }
      reset()
      continue
    }
    if (role !== "assistant") continue
    if (message.info?.summary === true) continue
    if (message.info?.error !== undefined) {
      reset()
      continue
    }
    if (hasCompletedFinish(message)) return { repeats: undefined, start: -1, recoveryAt }
    if (hasToolActivity(message)) {
      reset()
      continue
    }
    const output = generationOutput(message)
    if (output === undefined) {
      reset()
      continue
    }
    if (text !== undefined && output === text) repeats += 1
    else {
      text = output
      repeats = 1
      start = index
    }
  }

  return { repeats, start, recoveryAt }
}

function thresholdOf(repeats: number) {
  return Number.isInteger(repeats) && repeats >= 2 ? repeats : undefined
}

/**
 * Evaluate the current user turn for the recovery nudge. `stagnated` is the
 * nudge signal; it never terminates the review, and it never relaxes the
 * finish gate.
 */
export function reviewStagnationState(
  messages: readonly ReviewStagnationMessage[],
  repeats: number = DEFAULT_REPEATS,
): ReviewStagnationState {
  const threshold = thresholdOf(repeats)
  const run = reviewRun(currentTurn(messages))
  if (run.repeats === undefined) return { repeats: 0, stagnated: false }
  return { repeats: run.repeats, stagnated: threshold !== undefined && run.repeats >= threshold }
}

export type ReviewStagnationBackstop = {
  /** The report a generation of this turn already delivered. */
  readonly report: ReviewReport.Info
  /** That review as a finish result: its analysis plus one canonical envelope. */
  readonly result: string
}

/**
 * The canonical report already established by a generation of this turn.
 *
 * Every assistant generation is offered to the ReviewReport parser and the
 * last one that parses wins — the parser's own "last complete envelope is
 * canonical" rule, applied per generation. The trailing repeated output is
 * just another generation here: if the reviewer repeated its report, that
 * copy is the established one; if it repeated completion prose, the report
 * that came before it is. Nothing is read out of the repeated message, and a
 * turn with no parseable envelope returns the parser's explicit delivery
 * failure, so "no report" can never look like an empty successful review.
 */
function establishedReviewReport(messages: readonly ReviewStagnationMessage[]): ReviewReport.Delivery {
  let established: ReviewReport.Delivery | undefined
  for (const message of currentTurn(messages)) {
    if (messageRole(message) !== "assistant") continue
    if (message.info?.summary === true) continue
    if (message.info?.error !== undefined) continue
    const output = generationOutput(message)
    if (output === undefined) continue
    const delivery = ReviewReport.extract([output])
    if (delivery.ok) established = delivery
  }
  return established ?? ReviewReport.extract([])
}

/**
 * The deterministic backstop that ends the recovery loop (issue #176).
 *
 * Returns the established review result once the model has ignored the
 * recovery nudge: the identical run reached the threshold, a recovery nudge
 * was sent during that same run — a nudge from an earlier run, before a tool
 * call broke it, proves nothing — and the model repeated the output anyway.
 *
 * Returns undefined in every other case, including a turn that never
 * delivered a parseable report. Detecting stagnation is not by itself a
 * reason to complete a review: without a report the session loop keeps the
 * existing nudge and finish gating. The caller completes through the normal
 * `finish` path with `result`; this module never relaxes or re-implements
 * that gate.
 */
export function reviewStagnationBackstop(input: {
  messages: readonly ReviewStagnationMessage[]
  repeats?: number
  /** The text the session loop sends as its recovery nudge. */
  recoveryNudge: string
}): ReviewStagnationBackstop | undefined {
  const threshold = thresholdOf(input.repeats ?? DEFAULT_REPEATS)
  if (threshold === undefined) return undefined
  const run = reviewRun(currentTurn(input.messages), input.recoveryNudge)
  if (run.repeats === undefined || run.repeats < threshold) return undefined
  if (run.start < 0 || run.recoveryAt < run.start) return undefined
  const delivery = establishedReviewReport(input.messages)
  if (!delivery.ok) return undefined
  return { report: delivery.report, result: ReviewReport.render(delivery) }
}

export * as ReviewStagnation from "./review-stagnation"
