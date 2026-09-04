import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Ref } from "effect"
import * as Stream from "effect/Stream"

// Sentinel prefix for the clean-abort error below. SessionRetry.retryable
// explicitly excludes messages with this prefix so a tripped generation cap
// is never retried (retrying would replay the same runaway stream).
export const GENERATION_LIMIT_MESSAGE = "Generation limit exceeded"

// Generous byte budget per requested output token. A token averages ~4
// characters, so 10x headroom never clips legitimate output at the
// configured maxOutputTokens while still bounding a runaway stream to a few
// hundred KB of text (tens of MB worst case through the TUI render path,
// well under the ~1 GB RSS seen in the issue #89 segfaults).
export const CHARS_PER_OUTPUT_TOKEN = 10

// Fallback when the caller cannot provide maxOutputTokens (should not
// happen on the session path, which always resolves one).
export const GENERATION_CHAR_FALLBACK_MAX = 500_000

export function resolveMaxChars(input: { maxOutputTokens?: number; override?: number }): number {
  if (input.override !== undefined) return input.override
  const tokens = input.maxOutputTokens
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)
    return Math.ceil(tokens * CHARS_PER_OUTPUT_TOKEN)
  return GENERATION_CHAR_FALLBACK_MAX
}

export class GenerationLimitExceededError extends Error {
  override readonly name = "GenerationLimitExceededError"
  constructor(
    readonly maxChars: number,
    readonly seenChars: number,
  ) {
    super(
      `${GENERATION_LIMIT_MESSAGE}: assistant output exceeded ${maxChars} characters without completing. ` +
        `Aborted to protect the host process from runaway generation ` +
        `(override with OPENCODE_EXPERIMENTAL_GENERATION_CHAR_MAX).`,
    )
  }
}

function deltaLength(event: LLMEvent): number {
  if (LLMEvent.is.textDelta(event)) return event.text.length
  if (LLMEvent.is.reasoningDelta(event)) return event.text.length
  if (LLMEvent.is.toolInputDelta(event)) return event.text.length
  return 0
}

type GuardOptions = {
  readonly maxChars: number
}

// Bounds a single LLM generation stream by total streamed characters
// (text + reasoning + tool-input deltas share the model's output budget, so
// they share one cap). Exceeding the cap fails the stream with
// GenerationLimitExceededError, which the session processor surfaces as a
// clean non-retryable abort instead of accumulating unbounded state until
// the host process goes down (see issue #89).
export function guard<E, R>(
  self: Stream.Stream<LLMEvent, E, R>,
  options: GuardOptions,
): Stream.Stream<LLMEvent, E | GenerationLimitExceededError, R> {
  return Stream.unwrap(
    Effect.map(Ref.make(0), (seen) =>
      self.pipe(
        Stream.mapEffect((event) => {
          const delta = deltaLength(event)
          if (delta === 0) return Effect.succeed(event)
          return Ref.updateAndGet(seen, (total) => total + delta).pipe(
            Effect.flatMap((total) =>
              total <= options.maxChars
                ? Effect.succeed(event)
                : Effect.fail(new GenerationLimitExceededError(options.maxChars, total)),
            ),
          )
        }),
      ),
    ),
  )
}

export * as GenerationLimit from "./generation-limit"
