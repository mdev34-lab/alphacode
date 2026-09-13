import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"

// SessionRetry.retryable excludes messages with this prefix, so a tripped
// guard is never retried (retrying would replay the same looping stream).
export const REPETITION_MESSAGE = "Repetitive generation detected"

// Issue #94 defaults. Lines shorter than MIN_LINE_CHARS are too generic to
// identify a loop, and fragments shorter than MIN_UNIT_CHARS are almost
// always legitimate prose rhythm.
export const DEFAULT_LINE_REPEATS = 5
export const MIN_LINE_CHARS = 20
export const DEFAULT_UNIT_REPEATS = 3
export const MIN_UNIT_CHARS = 50

// Fragment-rule history: the last TAIL_CHARS characters of the current
// unfenced region, kept as delta segments and joined only at a checkpoint.
// The largest confirmable unit is (TAIL_CHARS - MIN_UNIT_CHARS) /
// (unitRepeats - 1) — about 4 KB at the defaults; longer units are left to
// the generation-length cap (issue #89), which bounds retention.
const TAIL_CHARS = 8192
const CHECK_EVERY_CHARS = 256
// Opening characters of a line, kept for the error message only: identity
// is a full-line hash and fence decisions use the streaming prefix below.
const PREVIEW_CHARS = 80

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// A line prefix that could still become a fence line: leading whitespace
// and at most two marker characters.
const FENCE_PENDING = /^\s*([`~]{0,2})?$/
// Separator art and brace walls repeat without carrying content.
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

// Length of the unit whose verbatim repetition ends `tail` — `repeats -
// 1` complete consecutive copies visible plus MIN_UNIT_CHARS of the
// repeats-th — or undefined. Lengths are tried shortest first with one
// backward early-exit comparison each: the evidence is len-periodicity
// over the tail's final (repeats - 1) * len + MIN_UNIT_CHARS characters,
// and a wrong length almost always mismatches immediately. The shortest
// confirming length is the minimal period, so a unit containing its own
// text again cannot be confirmed at a shorter cut; if it carries no
// alphanumeric the loop is contentless art and the scan stops for this
// checkpoint (longer confirmations are multiples of the same period).
function repeatedUnitLength(tail: string, repeats: number): number | undefined {
  const maxUnit = Math.floor((tail.length - MIN_UNIT_CHARS) / (repeats - 1))
  for (let len = MIN_UNIT_CHARS; len <= maxUnit; len++) {
    const span = Math.min((repeats - 1) * len + MIN_UNIT_CHARS, tail.length - len)
    let periodic = true
    for (let i = 0; i < span; i++) {
      if (tail.charCodeAt(tail.length - 1 - i) !== tail.charCodeAt(tail.length - 1 - i - len)) {
        periodic = false
        break
      }
    }
    if (!periodic) continue
    if (ALPHANUMERIC.test(tail.slice(-len))) return len
    return undefined
  }
  return undefined
}

// Detects a model stuck regenerating the same text without reaching a
// tool call (issue #94): identical lines, or one fragment verbatim, while
// the harness pays for every token. Both rules are scoped to a single
// text part and suppressed inside fenced code blocks (fenced rows are
// legitimate; the generation-length cap bounds them). Fences are decided
// by one machine over the line under construction: a line's leading
// characters are held back from the fragment tail until they settle
// whether it is a fence line — so an opener never reaches the tail even
// before its newline arrives — and every fence boundary resets the tail.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition: values below 2 disable a
    // rule instead of tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    let runHash: number | undefined
    let runLen = 0
    let runCount = 0
    let fenced = false
    let lineOpening = ""
    let lineLen = 0
    let lineHash = 0x811c9dc5 | 0
    let lineAlnum = false
    let lineBlank = true
    let tail: string[] = []
    let sinceCheck = 0
    // Fence state of the line under construction: "pending" can still
    // become a fence line (its prefix is held back), "fence" feeds
    // nothing, "plain" feeds everything.
    let lineFence: "pending" | "fence" | "plain" = "pending"
    let held = ""

    const resetRun = () => {
      runHash = undefined
      runCount = 0
    }
    const resetUnit = () => {
      tail = []
      sinceCheck = 0
    }
    const resetLine = () => {
      lineOpening = ""
      lineLen = 0
      lineHash = 0x811c9dc5 | 0
      lineAlnum = false
      lineBlank = true
      lineFence = "pending"
      held = ""
    }

    // Retains one unfenced segment; checks the tail every CHECK_EVERY_CHARS.
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

    // Consumes the completed line: toggles fences, feeds the separator
    // (plus anything held back while the fence question was open) to the
    // fragment tail, and walks the identical-line run. Blank lines are
    // transparent: paragraph breaks do not reset a run.
    const onLineComplete = (): string | undefined => {
      const isFence = lineFence === "fence"
      const late = lineFence === "pending" ? held : ""
      const len = lineLen
      const hash = lineHash
      const alnum = lineAlnum
      const blank = lineBlank
      const opening = lineOpening
      resetLine()
      if (isFence) {
        // A fence boundary starts a fresh tail in both directions.
        fenced = !fenced
        resetRun()
        resetUnit()
        return undefined
      }
      // Fenced content breaks the run: repetition that resumes after a
      // code block is not consecutive.
      if (fenced) {
        resetRun()
        return undefined
      }
      if (lineRule !== undefined && !blank) {
        // Identity is the full line's hash plus length, so lines sharing a
        // long opening but differing later are not identical.
        if (hash === runHash && len === runLen) runCount += 1
        else {
          runHash = hash
          runLen = len
          runCount = 1
        }
        if (runCount >= lineRule && len >= MIN_LINE_CHARS && alnum)
          return (
            `the model streamed the same line ("${opening}") ${runCount} times in a row without reaching a tool call. ` +
            `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
            `(Override with OPENCODE_EXPERIMENTAL_REPETITION_LINES.)`
          )
      }
      return feed(late + "\n")
    }

    // Streams one text delta through both rules. Fence state settles as
    // the line's opening characters arrive — inside a fenced block too,
    // where it recognizes the closer — and a segment is fed only if it
    // belongs to the unfenced region.
    const onText = (text: string): string | undefined => {
      const pieces = text.split("\n")
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) {
          const detail = onLineComplete()
          if (detail) return detail
        }
        const piece = pieces[i]
        lineLen += piece.length
        for (let c = 0; c < piece.length; c++) lineHash = Math.imul(lineHash ^ piece.charCodeAt(c), 16777619)
        if (!lineAlnum && ALPHANUMERIC.test(piece)) lineAlnum = true
        if (lineBlank && NON_WHITESPACE.test(piece)) lineBlank = false
        if (lineOpening.length < PREVIEW_CHARS) lineOpening = (lineOpening + piece).slice(0, PREVIEW_CHARS)
        if (lineFence === "pending") {
          const candidate = held + piece
          if (FENCE.test(candidate)) {
            // A fence line's bytes (info string included) never reach the
            // fragment tail, newline or not.
            held = ""
            lineFence = "fence"
          } else if (FENCE_PENDING.test(candidate)) {
            held = candidate
          } else {
            held = ""
            lineFence = "plain"
            if (!fenced) {
              const detail = feed(candidate)
              if (detail) return detail
            }
          }
          continue
        }
        if (lineFence === "plain" && !fenced) {
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
