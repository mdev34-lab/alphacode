import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"

// Sentinel prefix for the clean-abort error below. SessionRetry.retryable
// explicitly excludes messages with this prefix so a tripped repetition
// guard is never retried (retrying would replay the same looping stream).
export const REPETITION_MESSAGE = "Repetitive generation detected"

// Issue #94 defaults. A line shorter than MIN_LINE_CHARS is too generic to
// identify a loop (list markers, closing braces), and a repeated fragment
// shorter than MIN_UNIT_CHARS is almost always legitimate prose rhythm.
export const DEFAULT_LINE_REPEATS = 5
export const MIN_LINE_CHARS = 20
export const DEFAULT_UNIT_REPEATS = 3
export const MIN_UNIT_CHARS = 50

// Tail of the current text part kept for fragment detection. Bounds guard
// memory for a looping stream; the generation-length cap (issue #89) is the
// backstop for repetitions with units longer than what fits in the window.
const WINDOW_CHARS = 8192
// Fragment detection scans candidate periods, so it runs at most once per
// this many newly streamed characters rather than once per delta.
const CHECK_EVERY_CHARS = 32

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// Separator art, table rules, and brace walls repeat without carrying
// content; a loop needs at least one alphanumeric character to identify it.
const ALPHANUMERIC = /[a-z0-9]/i
const PREVIEW_CHARS = 80

export type Thresholds = {
  /** Consecutive identical significant lines that trip the guard. 0 disables. */
  readonly lineRepeats: number
  /** Consecutive repetitions of one MIN_UNIT_CHARS+ fragment that trip the guard. 0 disables. */
  readonly unitRepeats: number
}

export function resolveThresholds(input: { lineRepeats?: number; unitRepeats?: number }): Thresholds {
  return {
    lineRepeats: input.lineRepeats === undefined ? DEFAULT_LINE_REPEATS : input.lineRepeats,
    unitRepeats: input.unitRepeats === undefined ? DEFAULT_UNIT_REPEATS : input.unitRepeats,
  }
}

export class RepetitionDetectedError extends Error {
  override readonly name = "RepetitionDetectedError"
  constructor(readonly detail: string) {
    super(`${REPETITION_MESSAGE}: ${detail}`)
  }
}

type GuardOptions = {
  readonly thresholds: Thresholds
}

function preview(text: string) {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`
}

// Smallest length >= minUnit such that the window ends with a fragment of
// that length repeated `repeats` times in a row, or undefined. Candidate
// lengths are rejected in O(1) by comparing the character just before a
// would-be period with the last character, so the full slice comparison only
// runs on true periods (and their multiples).
function repeatedUnitLength(window: string, minUnit: number, repeats: number) {
  const n = window.length
  for (let len = minUnit; len <= Math.floor(n / repeats); len++) {
    if (window.charCodeAt(n - 1 - len) !== window.charCodeAt(n - 1)) continue
    const unit = window.slice(n - len)
    let repeated = true
    for (let r = 1; r < repeats; r++) {
      const start = n - len * (r + 1)
      if (window.slice(start, start + len) !== unit) {
        repeated = false
        break
      }
    }
    if (repeated) return len
  }
  return undefined
}

// Detects a model stuck regenerating the same text without ever reaching a
// tool call (issue #94): the stream repeats identical lines or one fragment
// verbatim while the harness keeps paying for every token. Two rules, both
// scoped to a single text part so state never leaks across a tool-call
// boundary, and both suppressed inside fenced code blocks: a fixture or
// table legitimately repeats rows, so fenced output stays bounded by the
// generation-length cap instead.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition, so values below 2 disable a
    // rule rather than tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    let window = ""
    let partial = ""
    let runLine = ""
    let runCount = 0
    let fenced = false
    let sinceCheck = 0

    const reset = () => {
      window = ""
      partial = ""
      runLine = ""
      runCount = 0
      fenced = false
      sinceCheck = 0
    }

    // Returns a human-readable detail when the line rule trips.
    const onLine = (line: string): string | undefined => {
      if (FENCE.test(line)) {
        fenced = !fenced
        runLine = ""
        runCount = 0
        return
      }
      const trimmed = line.trim()
      // Blank lines are transparent: a loop that separates its repetitions
      // with paragraph breaks still walks the run up one repetition at a time.
      if (trimmed === "") return
      // Any fenced content breaks the run: repetition that resumes after a
      // code block is not consecutive.
      if (fenced) {
        runLine = ""
        runCount = 0
        return
      }
      if (trimmed === runLine) runCount += 1
      else {
        runLine = trimmed
        runCount = 1
      }
      if (lineRule === undefined || runCount < lineRule) return
      if (trimmed.length < MIN_LINE_CHARS || !ALPHANUMERIC.test(trimmed)) return
      return (
        `the model streamed the same line ("${preview(trimmed)}") ${runCount} times in a row without reaching a tool call. ` +
        `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
        `(Override with OPENCODE_EXPERIMENTAL_REPETITION_LINES.)`
      )
    }

    // Returns a human-readable detail when the fragment rule trips.
    const onText = (text: string): string | undefined => {
      window += text
      // Amortized trim so per-delta copying stays O(delta) on a looping stream.
      if (window.length > WINDOW_CHARS * 2) window = window.slice(-WINDOW_CHARS)
      const lines = (partial + text).split("\n")
      partial = lines.pop() ?? ""
      if (partial.length > WINDOW_CHARS) partial = partial.slice(-WINDOW_CHARS)
      for (const line of lines) {
        const detail = onLine(line)
        if (detail) return detail
      }
      sinceCheck += text.length
      if (unitRule === undefined || fenced || sinceCheck < CHECK_EVERY_CHARS) return
      sinceCheck = 0
      const unit = repeatedUnitLength(window, MIN_UNIT_CHARS, unitRule)
      if (unit === undefined) return
      return (
        `the model streamed the same ${unit}-character fragment ${unitRule} times in a row without making progress. ` +
        `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
        `(Override with OPENCODE_EXPERIMENTAL_REPETITION_UNITS.)`
      )
    }

    // Returns a human-readable detail when a rule trips.
    const inspect = (event: LLMEvent): string | undefined => {
      if (LLMEvent.is.textStart(event)) {
        reset()
        return
      }
      if (!LLMEvent.is.textDelta(event)) return
      return onText(event.text)
    }

    return self.pipe(
      Stream.mapEffect((event) => {
        const detail = inspect(event)
        if (detail === undefined) return Effect.succeed(event)
        return Effect.fail(new RepetitionDetectedError(detail))
      }),
    )
  })
}

export * as RepetitionGuard from "./repetition-guard"
