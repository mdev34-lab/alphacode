/**
 * AI SDK `LanguageModelV3` implementation for the Qwen Web provider.
 *
 * This is the only module AlphaCode's LLM layer talks to: it converts AI SDK
 * calls into Qwen browser generations and Qwen streams into AI SDK parts
 * (text / reasoning / tool-call / usage / finish). All browser details stay
 * behind the session/transport layers.
 */
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { QWEN_WEB_PROVIDER_ID, type QwenWebReasoningMode } from "./constants"
import { QwenWebError, isAbortLike, isChallengeMessage, isQuotaMessage } from "./errors"
import { debug } from "./log"
import {
  formatThinkingSummary,
  incrementalDelta,
  QwenWebSSEParser,
  toUpstreamModelId,
  type QwenWebFileEntry,
} from "./protocol"
import { buildToolInstructions, functionTools, renderPrompt, type QwenWebToolDefinition } from "./prompt"
import { QwenWebSession } from "./session"
import { StreamingToolParser } from "./tool-parser"
import { QwenWebUpload } from "./upload"
import { refreshModelsInBackground } from "./catalog"
import { sharedBrowser } from "./browser"

export interface QwenWebModelOptions {
  reasoningMode?: QwenWebReasoningMode
  thinking?: boolean
  /** Test seams. */
  session?: QwenWebSession
  upload?: QwenWebUpload
}

export class QwenWebLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = QWEN_WEB_PROVIDER_ID
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly options: QwenWebModelOptions
  private readonly session: QwenWebSession
  private readonly upload: QwenWebUpload

  constructor(modelId: string, options?: QwenWebModelOptions) {
    this.modelId = modelId
    this.options = options ?? {}
    this.session = options?.session ?? new QwenWebSession()
    this.upload = options?.upload ?? new QwenWebUpload()
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const collected: LanguageModelV3Content[] = []
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
    let usage: LanguageModelV3Usage = emptyUsage()
    let textBuffer = ""
    let reasoningBuffer = ""
    const warnings = this.warnings(options)

    const flushText = () => {
      if (textBuffer) {
        collected.push({ type: "text", text: textBuffer })
        textBuffer = ""
      }
    }
    const flushReasoning = () => {
      if (reasoningBuffer) {
        collected.push({ type: "reasoning", text: reasoningBuffer })
        reasoningBuffer = ""
      }
    }

    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        switch (value.type) {
          case "text-start":
            flushReasoning()
            break
          case "text-delta":
            textBuffer += value.delta
            break
          case "text-end":
            flushText()
            break
          case "reasoning-start":
            flushText()
            break
          case "reasoning-delta":
            reasoningBuffer += value.delta
            break
          case "reasoning-end":
            flushReasoning()
            break
          case "tool-call":
            flushText()
            flushReasoning()
            collected.push(value)
            break
          case "error":
            throw value.error
          case "finish":
            finishReason = value.finishReason
            usage = value.usage
            break
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    flushText()
    flushReasoning()
    return { content: collected, finishReason, usage, warnings }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const signal = options.abortSignal
    if (signal?.aborted) throw toApiError(aborted(), this.modelId)
    const warnings = this.warnings(options)
    const tools = functionTools(options.tools as QwenWebToolDefinition[] | undefined)
    const useTools = tools.length > 0 && options.toolChoice?.type !== "none"

    const rendered = renderPrompt(options.prompt)
    let prompt = rendered.text
    if (useTools) prompt = `${buildToolInstructions(tools, options.toolChoice)}\n\n${prompt}`
    if (options.responseFormat?.type === "json") {
      const schema = options.responseFormat.schema
        ? `\n\nRespond with JSON matching this schema:\n${JSON.stringify(options.responseFormat.schema)}`
        : "\n\nRespond with valid JSON only."
      prompt = `${prompt}${schema}`
    }
    if (options.stopSequences && options.stopSequences.length > 0) {
      prompt = `${prompt}\n\n(Stop generating when you would emit any of: ${options.stopSequences.map((s) => JSON.stringify(s)).join(", ")})`
    }

    const upstreamModel = toUpstreamModelId(this.modelId)
    const reasoningMode = this.reasoningMode(options)

    debug("sdk", "starting generation", {
      model: upstreamModel,
      reasoningMode,
      promptChars: prompt.length,
      media: rendered.media.length,
      tools: useTools ? tools.length : 0,
    })

    const files = rendered.media.length > 0 ? await this.uploadFiles(rendered.media, signal) : undefined
    const generation = await this.startWithRetry({ prompt, model: upstreamModel, files, reasoningMode, signal })
    refreshModelsInBackground(() => sharedBrowser().isRunning())

    const parser = new StreamingToolParser({ declared: new Set(tools.map((tool) => tool.name)) })
    const stream = this.buildStream({ generation, parser, warnings, signal })
    return { stream }
  }

  private async uploadFiles(media: { source: string; mediaType?: string; filename?: string }[], signal?: AbortSignal) {
    try {
      return await this.upload.uploadAll(media, signal)
    } catch (error) {
      throw toApiError(error, this.modelId)
    }
  }

  /**
   * Start the generation, retrying once when the failure happened before any
   * upstream output could exist (chat creation / stream setup). Failures
   * after the stream starts are never retried (no duplicate generations).
   */
  private async startWithRetry(input: {
    prompt: string
    model: string
    files?: QwenWebFileEntry[]
    reasoningMode: QwenWebReasoningMode
    signal?: AbortSignal
  }) {
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.session.startGeneration(input)
      } catch (error) {
        lastError = error
        if (attempt === 2 || !this.isPreStreamRetryable(error)) break
        debug("sdk", `generation setup failed (attempt ${attempt}); retrying once`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw toApiError(lastError, this.modelId)
  }

  private isPreStreamRetryable(error: unknown): boolean {
    if (isAbortLike(error)) return false
    if (!QwenWebError.isInstance(error)) return false
    if (error.code === "login_required" || error.code === "session_expired" || error.code === "challenge") return false
    return error.retryable
  }

  private reasoningMode(options: LanguageModelV3CallOptions): QwenWebReasoningMode {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    const fromProviderOptions = providerOptions["reasoningMode"]
    if (fromProviderOptions === "auto" || fromProviderOptions === "thinking" || fromProviderOptions === "fast") {
      return fromProviderOptions
    }
    const thinking = providerOptions["thinking"] ?? this.options.thinking
    if (typeof thinking === "boolean") return thinking ? "thinking" : "fast"
    return this.options.reasoningMode ?? "auto"
  }

  private warnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
    const warnings: SharedV3Warning[] = []
    if (options.temperature !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: "temperature",
        details: "Qwen Web does not accept a temperature parameter.",
      })
    }
    if (options.topP !== undefined || options.topK !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: "sampling",
        details: "Qwen Web does not accept topP/topK parameters.",
      })
    }
    const tools = (options.tools ?? []) as QwenWebToolDefinition[]
    if (tools.some((tool) => tool.type !== "function")) {
      warnings.push({
        type: "unsupported",
        feature: "provider tools",
        details: "Only function tools are supported; provider tools were ignored.",
      })
    }
    return warnings
  }

  private buildStream(input: {
    generation: { chatId: string; response: { stream: ReadableStream<Uint8Array>; abort: () => void } }
    parser: StreamingToolParser
    warnings: SharedV3Warning[]
    signal?: AbortSignal
  }): ReadableStream<LanguageModelV3StreamPart> {
    const { generation, parser, warnings, signal } = input
    const modelId = this.modelId
    const session = this.session
    let responseId: string | undefined
    let stopping = false
    let finished = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    const stopUpstream = () => {
      if (stopping) return
      stopping = true
      void session.stopGeneration(generation.chatId, responseId, () => generation.response.abort()).catch(() => {})
    }
    const onAbort = () => stopUpstream()
    signal?.addEventListener("abort", onAbort, { once: true })

    const sse = new QwenWebSSEParser()
    const decoder = new TextDecoder()
    const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, "_")
    let blockCounter = 0
    let textAccumulated = ""
    let reasoningAccumulated = ""
    let currentTextId: string | undefined
    let currentReasoningId: string | undefined
    let toolCallCount = 0
    let usage: LanguageModelV3Usage = emptyUsage()
    let upstreamDone = false

    const endTextBlock = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentTextId !== undefined) {
        controller.enqueue({ type: "text-end", id: currentTextId })
        currentTextId = undefined
      }
    }
    const endReasoningBlock = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentReasoningId !== undefined) {
        controller.enqueue({ type: "reasoning-end", id: currentReasoningId })
        currentReasoningId = undefined
      }
    }
    const emitText = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, delta: string) => {
      if (!delta) return
      endReasoningBlock(controller)
      if (currentTextId === undefined) {
        currentTextId = `text-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "text-start", id: currentTextId })
      }
      controller.enqueue({ type: "text-delta", id: currentTextId, delta })
    }
    const emitReasoning = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, delta: string) => {
      if (!delta) return
      endTextBlock(controller)
      if (currentReasoningId === undefined) {
        currentReasoningId = `reasoning-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "reasoning-start", id: currentReasoningId })
      }
      controller.enqueue({ type: "reasoning-delta", id: currentReasoningId, delta })
    }

    const finishStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", onAbort)
      const flushed = parser.flush()
      if (flushed.text) emitText(controller, flushed.text)
      for (const call of flushed.toolCalls) {
        endTextBlock(controller)
        endReasoningBlock(controller)
        toolCallCount++
        controller.enqueue({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input })
      }
      endTextBlock(controller)
      endReasoningBlock(controller)
      const unified = toolCallCount > 0 ? "tool-calls" : "stop"
      controller.enqueue({ type: "finish", finishReason: { unified, raw: unified }, usage })
      controller.close()
      debug("sdk", "generation finished", { model: modelId, toolCalls: toolCallCount })
    }

    const failStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, error: unknown) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", onAbort)
      stopUpstream()
      controller.error(toApiError(error, modelId))
    }

    return new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
      },
      pull: async (controller) => {
        if (finished) return
        try {
          reader ??= generation.response.stream.getReader()
          if (upstreamDone) {
            finishStream(controller)
            return
          }
          const { done, value } = await reader.read()
          if (done || !value) {
            upstreamDone = true
            for (const event of sse.flush()) {
              if (finished) return
              handleEvent(controller, event)
            }
            if (!finished) finishStream(controller)
            return
          }
          const events = sse.feed(decoder.decode(value, { stream: true }))
          for (const event of events) {
            if (finished) return
            handleEvent(controller, event)
          }
          if (upstreamDone && !finished) finishStream(controller)
        } catch (error) {
          if (isAbortLike(error) || signal?.aborted) failStream(controller, aborted())
          else failStream(controller, error)
        }
      },
      cancel: () => {
        if (!finished) {
          finished = true
          signal?.removeEventListener("abort", onAbort)
          stopUpstream()
        }
        reader?.cancel().catch(() => {})
      },
    })

    function handleEvent(
      controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      event: ReturnType<QwenWebSSEParser["feed"]>[number],
    ): void {
      switch (event.kind) {
        case "done":
        case "answer-finished":
          upstreamDone = true
          return
        case "response-created":
          if (!responseId) {
            responseId = event.responseId
            controller.enqueue({ type: "response-metadata", id: event.responseId })
          }
          return
        case "error":
          throw classifyStreamError(event.code, event.message)
        case "usage":
          usage = {
            inputTokens: {
              total: event.inputTokens,
              noCache: undefined,
              cacheRead: event.cachedTokens,
              cacheWrite: undefined,
            },
            outputTokens: { total: event.outputTokens, text: event.textTokens, reasoning: event.reasoningTokens },
            raw: { totalTokens: event.totalTokens },
          }
          return
        case "thinking": {
          if (responseId && event.responseId && event.responseId !== responseId) return
          const formatted = formatThinkingSummary(event.delta)
          if (!formatted) return
          const result = incrementalDelta(reasoningAccumulated, formatted)
          if (result.delta === "FINISHED") return
          reasoningAccumulated = result.matched
          if (result.delta) emitReasoning(controller, result.delta)
          return
        }
        case "text": {
          if (responseId && event.responseId && event.responseId !== responseId) return
          if (event.responseId && !responseId) responseId = event.responseId
          const result = incrementalDelta(textAccumulated, event.content)
          if (result.delta === "FINISHED") return
          textAccumulated = result.matched
          if (!result.delta) return
          const parsed = parser.push(result.delta)
          if (parsed.text) emitText(controller, parsed.text)
          for (const call of parsed.toolCalls) {
            endTextBlock(controller)
            endReasoningBlock(controller)
            toolCallCount++
            controller.enqueue({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input })
          }
          return
        }
        case "unknown":
          return
      }
    }
  }
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function aborted(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web request was aborted", retryable: false })
  error.name = "AbortError"
  return error
}

/** Classify a mid-stream `data: {"error": ...}` payload. */
function classifyStreamError(code: string, message: string): QwenWebError {
  const detail = `${code} ${message}`.slice(0, 300)
  if (isQuotaMessage(detail)) {
    return new QwenWebError({
      code: "rate_limited",
      retryable: true,
      upstreamCode: code,
      message: `Qwen usage limit reached mid-stream (${message.slice(0, 200)}). Wait a little and retry, or switch to a smaller task.`,
    })
  }
  if (isChallengeMessage(detail)) {
    return new QwenWebError({
      code: "challenge",
      retryable: false,
      upstreamCode: code,
      message:
        "Qwen interrupted the stream with a human-verification challenge. Complete it in the Qwen browser profile, then retry.",
    })
  }
  return new QwenWebError({
    code: "upstream_error",
    retryable: true,
    upstreamCode: code,
    message: `Qwen stream error: ${message.slice(0, 280) || code || "unknown"}`,
  })
}

/** Map provider errors onto `APICallError` for AlphaCode's error pipeline. */
export function toApiError(error: unknown, modelId: string): APICallError {
  if (error instanceof APICallError) return error
  if (isAbortLike(error)) {
    return new APICallError({
      message: "Qwen Web request was aborted.",
      url: "https://chat.qwen.ai/api/v2/chat/completions",
      requestBodyValues: { model: modelId },
      statusCode: 499,
      isRetryable: false,
      cause: error,
    })
  }
  if (QwenWebError.isInstance(error)) {
    return new APICallError({
      message: error.message,
      url: "https://chat.qwen.ai/api/v2/chat/completions",
      requestBodyValues: { model: modelId },
      statusCode: error.status,
      responseBody: error.upstreamCode,
      isRetryable: error.retryable,
      cause: error,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new APICallError({
    message: `Qwen Web request failed: ${message.slice(0, 300)}`,
    url: "https://chat.qwen.ai/api/v2/chat/completions",
    requestBodyValues: { model: modelId },
    isRetryable: true,
    cause: error,
  })
}

/** Create a language model (used by the provider's custom model loader). */
export function createQwenWebModel(modelId: string, options?: Record<string, unknown>): QwenWebLanguageModel {
  return new QwenWebLanguageModel(modelId, {
    reasoningMode: asReasoningMode(options?.["reasoningMode"]) ?? asReasoningMode(options?.["reasoning_mode"]),
    thinking: typeof options?.["thinking"] === "boolean" ? (options["thinking"] as boolean) : undefined,
  })
}

/** Bundled SDK factory shape (`BUNDLED_PROVIDERS`). */
export function createQwenWeb(options?: Record<string, unknown>): {
  languageModel: (modelId: string) => QwenWebLanguageModel
} {
  return {
    languageModel: (modelId: string) => createQwenWebModel(modelId, options),
  }
}

function asReasoningMode(value: unknown): QwenWebReasoningMode | undefined {
  return value === "auto" || value === "thinking" || value === "fast" ? value : undefined
}
