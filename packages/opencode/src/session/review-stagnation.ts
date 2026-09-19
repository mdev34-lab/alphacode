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

export const DEFAULT_REPEATS = 3

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

// Evaluate the current user turn. Synthetic continuation nudges are skipped
// rather than treated as turn boundaries or progress, so the injected
// reminders between repetitions neither reset the run nor advance it. Any
// tool call — reads included, since reading is the reviewer's work — and any
// other state progress breaks the run, as does a failed generation, an
// empty one, or a new real user message. Summary assistants are
// harness-generated compaction output, not review generations.
export function reviewStagnationState(
  messages: readonly ReviewStagnationMessage[],
  repeats: number = DEFAULT_REPEATS,
): ReviewStagnationState {
  const threshold = Number.isInteger(repeats) && repeats >= 2 ? repeats : undefined
  const start = messages.findLastIndex((message) => messageRole(message) === "user" && !isSyntheticUser(message))
  const current = start < 0 ? messages : messages.slice(start + 1)

  let text: string | undefined
  let count = 0
  const reset = () => {
    text = undefined
    count = 0
  }

  for (const message of current) {
    const role = messageRole(message)
    if (role === "user") {
      // Defensive: the slice starts after the last real user message, so a
      // real one here only happens if the caller passed a wider window.
      if (!isSyntheticUser(message)) reset()
      continue
    }
    if (role !== "assistant") continue
    if (message.info?.summary === true) continue
    if (message.info?.error !== undefined) {
      reset()
      continue
    }
    if (hasCompletedFinish(message)) return { repeats: 0, stagnated: false }
    if (hasToolActivity(message)) {
      reset()
      continue
    }
    const output = generationOutput(message)
    if (output === undefined) {
      reset()
      continue
    }
    if (text !== undefined && output === text) count += 1
    else {
      text = output
      count = 1
    }
  }

  return { repeats: count, stagnated: threshold !== undefined && count >= threshold }
}

export * as ReviewStagnation from "./review-stagnation"
