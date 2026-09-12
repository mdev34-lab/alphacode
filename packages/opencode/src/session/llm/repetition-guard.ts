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

// Fragment-rule history: the last TAIL_CHARS characters of the current
// unfenced region. Segments are retained by reference while streaming and
// assembled into one string only at a checkpoint (every CHECK_EVERY_CHARS
// characters), so streaming does O(1) work per delta and assembly amortizes
// to a few bytes copied per character. Units longer than a third of the
// tail cannot be confirmed and are left to the generation cap (issue #89).
const TAIL_CHARS = 2048
const CHECK_EVERY_CHARS = 256
// Suffix used to locate the previous copy of the repeating unit: long
// enough that chance matches in prose are rare, short enough to occur at
// every period of a short loop.
const PROBE_CHARS = 16
// Stored identity of a line: its first LINE_KEY_CHARS characters plus its
// full length.
const LINE_KEY_CHARS = 200
const PREVIEW_CHARS = 80

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// Separator art, table rules, and brace walls repeat without carrying
// content; a loop worth aborting says something.
const ALPHANUMERIC = /[a-z0-9]/i
const NON_WHITESPACE = /\S/

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

// Length of the unit whose verbatim repetition ends `tail`, with `repeats`
// consecutive copies intact, or undefined. The length is located, not
// searched for: in a repeating stream every occurrence of the final
// PROBE_CHARS characters lands on a multiple of the minimal period, so one
// native backward scan finds the nearest previous copy and one three-way
// comparison confirms it. Worst case per checkpoint is one scan over the
// tail plus one comparison of `repeats` unit lengths.
function repeatedUnitLength(tail: string, repeats: number): number | undefined {
  if (tail.length < PROBE_CHARS + MIN_UNIT_CHARS) return undefined
  const probe = tail.slice(-PROBE_CHARS)
  // The closest occurrence at least one minimum unit back; anything nearer
  // is part of the final copy, not a repetition boundary.
  const hit = tail.lastIndexOf(probe, tail.length - PROBE_CHARS - MIN_UNIT_CHARS)
  if (hit < 0) return undefined
  const len = tail.length - PROBE_CHARS - hit
  if (len * repeats > tail.length) return undefined
  const unit = tail.slice(-len)
  if (!ALPHANUMERIC.test(unit)) return undefined
  for (let r = 2; r <= repeats; r++) {
    if (tail.slice(-r * len, -(r - 1) * len) !== unit) return undefined
  }
  return len
}

// Detects a model stuck regenerating the same text without ever reaching a
// tool call (issue #94): the stream repeats identical lines or one fragment
// verbatim while the harness keeps paying for every token. Two rules, both
// scoped to a single text part so state never leaks across a tool-call
// boundary, and both suppressed inside fenced code blocks: a fixture or
// table legitimately repeats rows, so fenced output stays bounded by the
// generation-length cap instead. Fenced bytes are never fed to the fragment
// tail and every fence boundary resets it, so fenced repetition cannot leak
// across a fence.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition, so values below 2 disable a
    // rule rather than tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    let runKey: string | undefined
    let runLen = 0
    let runCount = 0
    let fenced = false
    let lineParts: string[] = []
    let lineStored = 0
    let lineLen = 0
    let lineAlnum = false
    let lineBlank = true
    let tail: string[] = []
    let sinceCheck = 0

    const resetRun = () => {
      runKey = undefined
      runCount = 0
    }
    const resetUnit = () => {
      tail = []
      sinceCheck = 0
    }
    const resetLine = () => {
      lineParts = []
      lineStored = 0
      lineLen = 0
      lineAlnum = false
      lineBlank = true
    }

    // Retains one unfenced segment and, every CHECK_EVERY_CHARS characters,
    // checks the assembled tail for a verbatim repeated unit. Returns a
    // human-readable detail when the fragment rule trips.
    const feed = (segment: string): string | undefined => {
      if (unitRule === undefined) return undefined
      tail.push(segment)
      sinceCheck += segment.length
      if (sinceCheck < CHECK_EVERY_CHARS) return undefined
      sinceCheck = 0
      const text = tail.join("").slice(-TAIL_CHARS)
      tail = [text]
      const len = repeatedUnitLength(text, unitRule)
      if (len === undefined) return undefined
      return (
        `the model streamed the same ${len}-character fragment ${unitRule} times in a row without making progress. ` +
        `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
        `(Override with OPENCODE_EXPERIMENTAL_REPETITION_UNITS.)`
      )
    }

    // Consumes the completed line: toggles fences, feeds the line separator
    // to the fragment tail, and walks the identical-line run. Blank lines
    // are transparent: a loop that separates its repetitions with paragraph
    // breaks still walks the run up one repetition at a time.
    const onLineComplete = (): string | undefined => {
      const key = lineParts.join("").slice(0, LINE_KEY_CHARS)
      const len = lineLen
      const alnum = lineAlnum
      const blank = lineBlank
      resetLine()
      if (FENCE.test(key)) {
        fenced = !fenced
        resetRun()
        resetUnit()
        return undefined
      }
      if (fenced) {
        // Fenced content breaks the run: repetition that resumes after a
        // code block is not consecutive, and fenced bytes never reach the
        // fragment tail.
        resetRun()
        return undefined
      }
      if (lineRule !== undefined && !blank) {
        if (key === runKey && len === runLen) runCount += 1
        else {
          runKey = key
          runLen = len
          runCount = 1
        }
        if (runCount >= lineRule && len >= MIN_LINE_CHARS && alnum)
          return (
            `the model streamed the same line ("${preview(key)}") ${runCount} times in a row without reaching a tool call. ` +
            `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
            `(Override with OPENCODE_EXPERIMENTAL_REPETITION_LINES.)`
          )
      }
      return feed("\n")
    }

    // Streams one text delta through both rules. Completed lines toggle the
    // fence state as they arrive; each segment is fed only if it belongs to
    // the unfenced region, so every character is retained exactly once,
    // under the fence state in effect while it streamed.
    const onText = (text: string): string | undefined => {
      const pieces = text.split("\n")
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) {
          const detail = onLineComplete()
          if (detail) return detail
        }
        const piece = pieces[i]
        lineLen += piece.length
        if (!lineAlnum && ALPHANUMERIC.test(piece)) lineAlnum = true
        if (lineBlank && NON_WHITESPACE.test(piece)) lineBlank = false
        if (lineStored < LINE_KEY_CHARS) {
          lineParts.push(piece)
          lineStored += piece.length
        }
        if (!fenced) {
          const detail = feed(piece)
          if (detail) return detail
        }
      }
      return undefined
    }

    const inspect = (event: LLMEvent): string | undefined => {
      if (LLMEvent.is.textStart(event)) {
        resetRun()
        resetUnit()
        resetLine()
        fenced = false
        return undefined
      }
      if (!LLMEvent.is.textDelta(event)) return undefined
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
