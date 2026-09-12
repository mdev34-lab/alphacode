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

// Tail of the current unfenced region kept for fragment detection, as a
// fixed-size ring buffer of UTF-16 code units: appending a delta writes its
// code units into preallocated memory, so the cost is O(delta) with zero
// steady-state allocations — no string concatenation, no slicing, no trim.
// The generation-length cap (issue #89) is the backstop for repetitions
// whose unit is longer than a third of this window.
const WINDOW_CHARS = 8192
// Fragment detection scans candidate unit lengths over the ring buffer, so
// it runs at most once per this many newly fed characters rather than once
// per delta. A persistent loop remains detectable at every checkpoint, so
// the interval only delays detection by a bounded number of characters; it
// never changes what is detected.
const CHECK_EVERY_CHARS = 256

// Identity of the line currently streaming: a capped head for fence
// detection, a capped preview for the abort message, and two rolling hashes
// plus the length for equality. Everything is O(1) per streamed character
// and bounded regardless of line length, so an unterminated pathological
// line cannot grow state without bound.
const LINE_HEAD_CHARS = 128
const PREVIEW_CHARS = 80

// Markdown fence markers open and close code blocks on their own line.
const FENCE = /^\s*(```|~~~)/
// Separator art, table rules, and brace walls repeat without carrying
// content; a loop needs at least one alphanumeric character to identify it.
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

// A line under construction. `h1` (FNV-1a) and `h2` (djb2) together make the
// identity; two distinct lines colliding on both hashes and the length is
// not something non-adversarial text produces.
type Line = {
  head: string
  preview: string
  length: number
  hasAlnum: boolean
  blank: boolean
  h1: number
  h2: number
}

const emptyLine = (): Line => ({
  head: "",
  preview: "",
  length: 0,
  hasAlnum: false,
  blank: true,
  h1: 0x811c9dc5 | 0,
  h2: 5381,
})

function appendLine(line: Line, text: string) {
  if (text.length === 0) return
  line.length += text.length
  if (!line.hasAlnum && ALPHANUMERIC.test(text)) line.hasAlnum = true
  if (line.blank && NON_WHITESPACE.test(text)) line.blank = false
  if (line.head.length < LINE_HEAD_CHARS) line.head = (line.head + text).slice(0, LINE_HEAD_CHARS)
  if (line.preview.length < PREVIEW_CHARS) line.preview = (line.preview + text).slice(0, PREVIEW_CHARS)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    line.h1 = Math.imul(line.h1 ^ code, 16777619)
    line.h2 = (Math.imul(line.h2, 33) + code) | 0
  }
}

function sameLine(a: Line, b: Line) {
  return a.length === b.length && a.h1 === b.h1 && a.h2 === b.h2
}

function preview(text: string) {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`
}

// Detects a model stuck regenerating the same text without ever reaching a
// tool call (issue #94): the stream repeats identical lines or one fragment
// verbatim while the harness keeps paying for every token. Two rules, both
// scoped to a single text part so state never leaks across a tool-call
// boundary, and both suppressed inside fenced code blocks: a fixture or
// table legitimately repeats rows, so fenced output stays bounded by the
// generation-length cap instead. Fenced suppression is structural — fenced
// bytes are never fed to the fragment window, and every fence boundary
// resets it, so repeated rows inside a block cannot influence detection
// after the block closes.
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | RepetitionDetectedError, R> {
  return Stream.suspend(() => {
    // A single occurrence is not repetition, so values below 2 disable a
    // rule rather than tripping on the first significant line.
    const lineRule = options.thresholds.lineRepeats >= 2 ? options.thresholds.lineRepeats : undefined
    const unitRule = options.thresholds.unitRepeats >= 2 ? options.thresholds.unitRepeats : undefined

    // Ring buffer over the last WINDOW_CHARS fed characters. `written` is
    // the absolute count of characters ever fed; position p lives at
    // ring[p % WINDOW_CHARS] and is valid while p >= written - WINDOW_CHARS.
    const ring = new Uint16Array(WINDOW_CHARS)
    let written = 0
    let sinceCheck = 0
    let line = emptyLine()
    let fenced = false
    let runLine: Line | undefined
    let runCount = 0

    const resetRun = () => {
      runLine = undefined
      runCount = 0
    }
    const resetUnit = () => {
      written = 0
      sinceCheck = 0
    }
    const reset = () => {
      resetRun()
      resetUnit()
      line = emptyLine()
      fenced = false
    }

    // Smallest unit length >= MIN_UNIT_CHARS such that the window ends with
    // that unit repeated `repeats` times in a row, or undefined. Every
    // candidate is rejected in O(1) — the code unit just before a would-be
    // unit boundary must equal the last code unit — so one scan is a bounded
    // pass of integer compares over at most WINDOW_CHARS / MIN_UNIT_CHARS
    // candidates (~10 per streamed character at the 8 KiB window, run every
    // CHECK_EVERY_CHARS characters) and performs no string allocation. Full
    // comparisons only run for candidates that pass the boundary check; the
    // scan returns on the first confirmation and a confirmed repetition
    // aborts the stream, so against a real loop the work happens once.
    const scan = (): string | undefined => {
      if (unitRule === undefined) return undefined
      const n = written
      const windowStart = Math.max(0, n - WINDOW_CHARS)
      const maxUnit = Math.floor((n - windowStart) / unitRule)
      for (let len = MIN_UNIT_CHARS; len <= maxUnit; len++) {
        if (ring[(n - 1 - len) % WINDOW_CHARS] !== ring[(n - 1) % WINDOW_CHARS]) continue
        let repeated = true
        for (let r = 1; r < unitRule; r++) {
          const base = n - len * (r + 1)
          if (base < windowStart) {
            repeated = false
            break
          }
          for (let j = 0; j < len; j++) {
            if (ring[(base + j) % WINDOW_CHARS] !== ring[(n - len + j) % WINDOW_CHARS]) {
              repeated = false
              break
            }
          }
          if (!repeated) break
        }
        if (repeated)
          return (
            `the model streamed the same ${len}-character fragment ${unitRule} times in a row without making progress. ` +
            `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
            `(Override with OPENCODE_EXPERIMENTAL_REPETITION_UNITS.)`
          )
      }
      return undefined
    }

    // Appends unfenced text to the fragment window and periodically scans
    // it. Returns a human-readable detail when the fragment rule trips.
    const feed = (text: string): string | undefined => {
      for (let i = 0; i < text.length; i++) ring[written++ % WINDOW_CHARS] = text.charCodeAt(i)
      sinceCheck += text.length
      if (sinceCheck < CHECK_EVERY_CHARS) return undefined
      sinceCheck = 0
      return scan()
    }

    // Consumes the completed line: toggles fences, feeds the line separator
    // to the fragment window, and walks the identical-line run. Blank lines
    // are transparent: a loop that separates its repetitions with paragraph
    // breaks still walks the run up one repetition at a time.
    const onLineComplete = (): string | undefined => {
      const current = line
      line = emptyLine()
      if (FENCE.test(current.head)) {
        fenced = !fenced
        resetRun()
        // A fence boundary starts a fresh fragment window in both
        // directions, so fenced repetition cannot leak across it.
        resetUnit()
        return undefined
      }
      if (fenced) {
        // Any fenced content breaks the run: repetition that resumes after
        // a code block is not consecutive, and fenced bytes never reach
        // the fragment window.
        resetRun()
        return undefined
      }
      if (lineRule !== undefined && !current.blank) {
        if (runLine !== undefined && sameLine(runLine, current)) runCount += 1
        else {
          runLine = current
          runCount = 1
        }
        if (runCount >= lineRule && current.length >= MIN_LINE_CHARS && current.hasAlnum)
          return (
            `the model streamed the same line ("${preview(current.preview)}") ${runCount} times in a row without reaching a tool call. ` +
            `Aborted the stream instead of paying for more of the same; retry or rephrase the prompt. ` +
            `(Override with OPENCODE_EXPERIMENTAL_REPETITION_LINES.)`
          )
      }
      return feed("\n")
    }

    // Streams one text delta through both rules. The delta is split on line
    // breaks: each completed line is processed (which may toggle the fence
    // state mid-delta), and only the segments that belong to the unfenced
    // region are fed to the fragment window. Every character is fed exactly
    // once, under the fence state in effect while it streamed.
    const onText = (text: string): string | undefined => {
      const pieces = text.split("\n")
      appendLine(line, pieces[0])
      if (!fenced) {
        const detail = feed(pieces[0])
        if (detail) return detail
      }
      for (let i = 1; i < pieces.length; i++) {
        const detail = onLineComplete()
        if (detail) return detail
        appendLine(line, pieces[i])
        if (!fenced) {
          const detail = feed(pieces[i])
          if (detail) return detail
        }
      }
      return undefined
    }

    // Returns a human-readable detail when a rule trips.
    const inspect = (event: LLMEvent): string | undefined => {
      if (LLMEvent.is.textStart(event)) {
        reset()
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
