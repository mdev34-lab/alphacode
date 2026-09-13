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
// to a few bytes copied per character. A unit only confirms when the tail
// shows unitRepeats - 1 complete copies plus MIN_UNIT_CHARS of the next, so
// the largest confirmable unit is (TAIL_CHARS - MIN_UNIT_CHARS) / 2 — about
// 4 KB at the defaults. Units longer than that are left to the
// generation-length cap (issue #89); confirming arbitrarily long units would
// need arbitrarily long retention, which is exactly what the cap bounds.
const TAIL_CHARS = 8192
const CHECK_EVERY_CHARS = 256
// Suffix used to locate the previous copy of the repeating unit: long
// enough that chance matches in prose are rare, short enough to occur at
// every period of a short loop.
const PROBE_CHARS = 16
// Previous occurrences of the probe tried as candidate unit lengths per
// checkpoint. Bounds the walk over finer probe phases (a shared line
// suffix) and adversarial text; a persistent loop retries every checkpoint.
const MAX_CANDIDATES = 256
// Characters of a candidate unit inspected for content. Separator art
// (dashes, rules, brace walls) carries no alphanumeric anywhere; real text
// carries it in any window this large.
const ALNUM_SAMPLE_CHARS = 256
// Stored opening of a line, for fence detection and message previews. Line
// identity itself is a full-line FNV-1a hash plus the length, so lines that
// share this opening but differ later are not conflated.
const LINE_KEY_CHARS = 200
const PREVIEW_CHARS = 80

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// A line prefix that could still become a fence line: leading whitespace
// and at most two marker characters. Anything else settles the question.
const FENCE_PENDING = /^\s*([`~]{0,2})?$/
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

// Length of the unit whose verbatim repetition ends `tail`, with
// `repeats - 1` complete consecutive copies visible plus MIN_UNIT_CHARS of
// the repeats-th, or undefined. The length is located, not searched for: in
// a repeating stream the trailing PROBE_CHARS characters recur at every
// copy of the unit, so the previous occurrences of that suffix — nearest
// first — are the candidate unit lengths, and one aligned comparison
// confirms or refutes each. When the unit repeats the probe's phase more
// finely (a line suffix shared by every row, say) the true length is simply
// a few more candidates back, each rejected at its first mismatch, so at
// most MAX_CANDIDATES occurrences are tried per checkpoint and a persistent
// loop re-offers them every checkpoint until one confirms.
function repeatedUnitLength(tail: string, repeats: number): number | undefined {
  if (tail.length < PROBE_CHARS + MIN_UNIT_CHARS) return undefined
  const probe = tail.slice(-PROBE_CHARS)
  const maxUnit = Math.floor((tail.length - MIN_UNIT_CHARS) / (repeats - 1))
  // The closest occurrence at least one minimum unit back; anything nearer
  // is part of the final copy, not a repetition boundary.
  let bound = tail.length - PROBE_CHARS - MIN_UNIT_CHARS
  for (let tried = 0; tried < MAX_CANDIDATES; tried++) {
    const hit = tail.lastIndexOf(probe, bound)
    if (hit < 0) return undefined
    const len = tail.length - PROBE_CHARS - hit
    // Candidates only grow longer from here; past maxUnit the required
    // copies cannot fit the tail, so those loops are left to the cap.
    if (len > maxUnit) return undefined
    const sample = len > ALNUM_SAMPLE_CHARS ? tail.slice(-len, -len + ALNUM_SAMPLE_CHARS) : tail.slice(-len)
    if (!ALPHANUMERIC.test(sample)) {
      bound = hit - 1
      continue
    }
    if (repeats < 3) {
      // A two-repetition threshold is inherently weak evidence: the probe's
      // previous hit plus a MIN_UNIT_CHARS window repeating one period
      // earlier is all there is to see.
      if (tail.slice(-len - MIN_UNIT_CHARS, -len) !== tail.slice(-MIN_UNIT_CHARS)) {
        bound = hit - 1
        continue
      }
      return len
    }
    const unit = tail.slice(-len)
    let confirmed = true
    for (let r = 2; r < repeats; r++) {
      if (tail.slice(-r * len, -(r - 1) * len) !== unit) {
        confirmed = false
        break
      }
    }
    // The repeats-th copy is underway: the MIN_UNIT_CHARS ending one period
    // before the tail end repeat one period earlier still.
    if (
      confirmed &&
      tail.slice(-(repeats - 1) * len - MIN_UNIT_CHARS, -(repeats - 1) * len) !==
        tail.slice(-len - MIN_UNIT_CHARS, -len)
    )
      confirmed = false
    if (confirmed) return len
    bound = hit - 1
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
//
// Fenced suppression holds at streaming granularity: a line only becomes a
// fence when its opening characters say so, so each line's leading
// characters are held back from the fragment tail until they settle the
// question (leading whitespace and one or two marker characters can still
// become a fence; anything else cannot). Fence bytes therefore never reach
// the tail even before the fence's terminating newline arrives, and every
// fence boundary resets the tail, so fenced repetition cannot leak across
// it in either direction.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition, so values below 2 disable a
    // rule rather than tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    let runHash: number | undefined
    let runLen = 0
    let runCount = 0
    let fenced = false
    let lineParts: string[] = []
    let lineStored = 0
    let lineLen = 0
    let lineHash = 0x811c9dc5 | 0
    let lineAlnum = false
    let lineBlank = true
    let tail: string[] = []
    let sinceCheck = 0
    // Fence state of the line under construction, decided by its opening
    // characters: "pending" can still become a fence line (its undecidable
    // prefix is held back from the tail), "fence" is one and feeds nothing,
    // "plain" feeds everything.
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
      lineParts = []
      lineStored = 0
      lineLen = 0
      lineHash = 0x811c9dc5 | 0
      lineAlnum = false
      lineBlank = true
      lineFence = "pending"
      held = ""
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
    // (plus anything held back while the fence question was open) to the
    // fragment tail, and walks the identical-line run. Blank lines are
    // transparent: a loop that separates its repetitions with paragraph
    // breaks still walks the run up one repetition at a time.
    const onLineComplete = (): string | undefined => {
      const key = lineParts.join("").slice(0, LINE_KEY_CHARS)
      const len = lineLen
      const hash = lineHash
      const alnum = lineAlnum
      const blank = lineBlank
      const late = held
      resetLine()
      if (FENCE.test(key)) {
        fenced = !fenced
        resetRun()
        // A fence boundary starts a fresh fragment tail in both directions,
        // so fenced repetition cannot leak across it.
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
        // Identity is the full line's rolling hash plus length: the stored
        // key is only a prefix, so lines that share a long opening but
        // differ later must not count as identical.
        if (hash === runHash && len === runLen) runCount += 1
        else {
          runHash = hash
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
      return feed(late + "\n")
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
        for (let c = 0; c < piece.length; c++) lineHash = Math.imul(lineHash ^ piece.charCodeAt(c), 16777619)
        if (!lineAlnum && ALPHANUMERIC.test(piece)) lineAlnum = true
        if (lineBlank && NON_WHITESPACE.test(piece)) lineBlank = false
        if (lineStored < LINE_KEY_CHARS) {
          lineParts.push(piece)
          lineStored += piece.length
        }
        if (fenced || lineFence === "fence") continue
        if (lineFence === "pending") {
          const candidate = held + piece
          if (FENCE.test(candidate)) {
            // This line is a fence: its bytes (including any info string)
            // never reach the fragment tail, newline or not.
            held = ""
            lineFence = "fence"
          } else if (FENCE_PENDING.test(candidate)) {
            held = candidate
          } else {
            held = ""
            lineFence = "plain"
            const detail = feed(candidate)
            if (detail) return detail
          }
          continue
        }
        const detail = feed(piece)
        if (detail) return detail
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
