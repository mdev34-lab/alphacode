export * as ContextCompressor from "./compressor"

import { LLM, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { SessionCompaction } from "../session/compaction"
import { Token } from "../util/token"
import type { CompressionBlock, ContextMessage } from "./types"

const MAX_OUTPUT_TOKENS = 4_096

/**
 * Hard ceiling on a stored summary.
 *
 * `maxTokens` is a request to the provider, not a guarantee, and a summary is durable state that
 * later compressions read back as source material. Capping it deterministically keeps nested
 * compression from turning context reduction into database growth.
 */
export const MAX_SUMMARY_CHARS = MAX_OUTPUT_TOKENS * 4
export const TRUNCATED_MARKER = "[summary truncated at the compression output budget]"

const cap = (summary: string) =>
  summary.length <= MAX_SUMMARY_CHARS ? summary : `${summary.slice(0, MAX_SUMMARY_CHARS)}\n${TRUNCATED_MARKER}`

const INSTRUCTIONS = `You are compressing a completed section of a coding agent's conversation into a technical state summary.

The summary replaces the original messages in the agent's future context. Optimize it for another agent continuing the work, not for a human reader.

Preserve:
- user requirements and explicit directives
- decisions and the reasoning that justified them
- architecture, interfaces, and data flow that were established
- files created, changed, or read, with exact paths and symbols
- important code behavior and constraints
- unresolved bugs, failures, and their causes
- test and command results that still matter
- active TODOs and assumptions
- important tool outputs, including exact identifiers, error strings, and commands

Discard:
- conversational filler and acknowledgements
- repeated explanations
- obsolete or superseded tool output
- redundant command output
- intermediate reasoning that no longer affects the task

Rules:
- Output only the summary. No preamble, no closing remarks.
- Use terse bullets grouped under short headings.
- Never invent facts that are not present in the transcript.
- Do not address the user and do not mention that compression happened.`

export interface PromptInput {
  readonly messages: readonly ContextMessage[]
  readonly focus?: string
  /** Summaries of ranges nested inside this compression, oldest first. */
  readonly nested?: readonly string[]
}

/**
 * Build the compression prompt.
 *
 * Nested summaries are supplied as source material so an overlapping compression never loses what
 * an earlier, narrower compression already condensed.
 */
export const buildPrompt = (input: PromptInput) => {
  const transcript = input.messages.map(SessionCompaction.serialize).filter(Boolean).join("\n\n")
  return [
    INSTRUCTIONS,
    ...(input.nested?.length
      ? [
          `Earlier summaries covering parts of this same section follow. Carry their still-relevant content forward; anything you omit is lost.\n\n<prior-summaries>\n${input.nested.join(
            "\n\n---\n\n",
          )}\n</prior-summaries>`,
        ]
      : []),
    `<transcript>\n${transcript}\n</transcript>`,
    ...(input.focus === undefined || input.focus.trim().length === 0
      ? []
      : [`Focus the summary on: ${input.focus.trim()}`]),
  ].join("\n\n")
}

export interface SummarizeInput extends PromptInput {
  readonly model: Model
  readonly http?: LLMRequest["http"]
}

export interface Dependencies {
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, never> }
}

/**
 * Run one isolated summarization request.
 *
 * Compression is an internal LLM call: it builds its own request, never re-enters the context
 * manager, and never advertises tools. That is what keeps `compress -> prepare -> compress` from
 * becoming possible.
 */
export const summarize = Effect.fn("ContextCompressor.summarize")(function* (
  llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, unknown> },
  input: SummarizeInput,
) {
  const prompt = buildPrompt(input)
  const limit = input.model.route.defaults.limits?.context
  const output = Math.min(input.model.route.defaults.limits?.output ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
  if (limit !== undefined && limit > 0 && Token.estimate(prompt) > limit - output) return undefined
  const chunks: string[] = []
  let failed = false
  const completed = yield* llm
    .stream(
      LLM.request({
        model: input.model,
        http: input.http,
        messages: [Message.user(prompt)],
        tools: [],
        generation: { maxTokens: output },
      }),
    )
    .pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
        return Effect.void
      }),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    )
  const summary = chunks.join("").trim()
  if (!completed || failed || summary.length === 0) return undefined
  return cap(summary)
})

/** Assemble the durable metadata for a completed compression. */
export const block = (input: {
  readonly id: string
  readonly messages: readonly ContextMessage[]
  readonly summary: string
  readonly focus?: string
  readonly nested: readonly string[]
  readonly createdAt: number
}): CompressionBlock => ({
  id: input.id,
  startMessageID: input.messages[0]!.id,
  endMessageID: input.messages[input.messages.length - 1]!.id,
  summary: input.summary,
  focus: input.focus,
  createdAt: input.createdAt,
  sourceMessageCount: input.messages.length,
  sourceTokenCount: Token.estimate(JSON.stringify(input.messages)),
  summaryTokenCount: Token.estimate(input.summary),
  nested: input.nested,
})
