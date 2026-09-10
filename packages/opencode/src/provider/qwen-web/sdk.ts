/**
 * AI SDK `LanguageModelV3` implementation for the Qwen Web provider.
 *
 * This is the only module AlphaCode's LLM layer talks to: it converts AI SDK
 * calls into incremental turns on the provider's persistent thread and maps
 * the canonical webchat events (text / thinking / tool-call / usage / finish)
 * onto AI SDK stream parts. All browser and streaming details stay behind the
 * session/transport layers.
 */
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { QWEN_WEB_PROVIDER_ID, type QwenWebReasoningMode } from "@opencode-ai/webchat/adapters/qwen/constants"
import { QwenWebError, isAbortLike } from "@opencode-ai/webchat/adapters/qwen/errors"
import { debug } from "@opencode-ai/webchat/adapters/qwen/log"
import { toUpstreamModelId } from "@opencode-ai/webchat/adapters/qwen/protocol"
import { buildToolInstructions, functionTools, renderPrompt, type QwenWebToolDefinition } from "./prompt"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { lastAnchored } from "@opencode-ai/webchat/thread"
import { QwenWebUpload } from "@opencode-ai/webchat/adapters/qwen/upload"
import { refreshModelsInBackground, resolveUpstreamModelId } from "./catalog"
import { sharedBrowser } from "@opencode-ai/webchat/adapters/qwen/browser"
import type { RenderedPrompt } from "./prompt"
import type { WebChatEvent, WebChatThread, WebChatUsage } from "@opencode-ai/webchat/types"

export interface QwenWebModelOptions {
  reasoningMode?: QwenWebReasoningMode
  thinking?: boolean
  /** Test seams. */
  session?: QwenWebSession
  upload?: QwenWebUpload
}

// Follow-ups on a thread that already has a committed assistant response
// re-send only the tail after that response (the transcript before it lives
// in the upstream chat, chained via `parent_id`). Lite streams (session
// titles/subtitles) keep the full prompt: their thread is a scratchpad for
// the current conversation and carries no reusable upstream context.
// Assumption (signed off): the upstream thread mirrors the prompt's pre-tail
// transcript. In-place message edits or a mid-session switch away from qwen
// and back diverge from that mirror and degrade to stale context rather than
// failing — both are rare flows; the trim's common-case benefit stands.
function incrementalPrompt(
  prompt: LanguageModelV3Prompt,
  thread: WebChatThread,
  lite: boolean,
): RenderedPrompt | undefined {
  if (lite) return undefined
  if (!lastAnchored(thread)?.providerState?.responseId) return undefined
  let lastAssistant = -1
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]!.role === "assistant") {
      lastAssistant = index
      break
    }
  }
  if (lastAssistant < 0 || lastAssistant >= prompt.length - 1) return undefined
  const tail = renderPrompt(prompt.slice(lastAssistant + 1))
  if (tail.text.trim().length === 0) return undefined
  return tail
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

    let rendered = renderPrompt(options.prompt)
    const wrap = (p: string): string => {
      let out = p
      if (useTools) out = `${buildToolInstructions(tools, options.toolChoice)}\n\n${out}`
      if (options.responseFormat?.type === "json") {
        const schema = options.responseFormat.schema
          ? `\n\nRespond with JSON matching this schema:\n${JSON.stringify(options.responseFormat.schema)}`
          : "\n\nRespond with valid JSON only."
        out = `${out}${schema}`
      }
      if (options.stopSequences && options.stopSequences.length > 0) {
        out = `${out}\n\n(Stop generating when you would emit any of: ${options.stopSequences.map((s) => JSON.stringify(s)).join(", ")})`
      }
      return out
    }
    let prompt = wrap(rendered.text)

    // Strip reasoning variants first, then translate any legacy catalog id
    // (e.g. `qwen3-max`) onto the live upstream catalog so requests never
    // carry an id the server has retired (`Not_Found: Model not found`).
    const upstreamModel = resolveUpstreamModelId(toUpstreamModelId(this.modelId))
    const reasoningMode = this.reasoningMode(options)

    debug("sdk", "starting generation", {
      model: upstreamModel,
      reasoningMode,
      promptChars: prompt.length,
      media: rendered.media.length,
      tools: useTools ? tools.length : 0,
    })

    refreshModelsInBackground(() => sharedBrowser().isRunning())

    // One persistent thread per model (+optional per-agent scope). The turn
    // is incremental: only this turn's prompt is sent, chained upstream.
    const thread = await this.session.ensureThread({ model: upstreamModel, scope: this.threadScope(options) })
    const trim = incrementalPrompt(options.prompt, thread, this.isLite(options))
    if (trim) {
      rendered = trim
      prompt = wrap(trim.text)
    }
    const files = rendered.media.length > 0 ? await this.uploadFiles(rendered.media, signal) : undefined
    const toolDeclarations = useTools
      ? tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema,
        }))
      : undefined

    // Cancelling the mapped stream (or the caller aborting) must stop the
    // upstream generation: an internal signal fans the abort into the turn.
    const internalAbort = new AbortController()
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          internalAbort.abort()
        },
        { once: true },
      )
    }
    const generator = this.session.runTurn({
      thread,
      content: prompt,
      tools: toolDeclarations,
      files,
      reasoningMode,
      signal: internalAbort.signal,
    })
    const stream = this.buildStream({
      generator,
      warnings,
      signal: internalAbort.signal,
      onCancel: () => internalAbort.abort(),
    })
    return { stream }
  }

  private threadScope(options: LanguageModelV3CallOptions): string | undefined {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    const threadId = providerOptions["threadId"]
    return typeof threadId === "string" && threadId ? threadId : undefined
  }

  private isLite(options: LanguageModelV3CallOptions): boolean {
    const providerOptions = (options.providerOptions?.[QWEN_WEB_PROVIDER_ID] ?? {}) as Record<string, unknown>
    return providerOptions["small"] === true
  }

  private async uploadFiles(media: { source: string; mediaType?: string; filename?: string }[], signal?: AbortSignal) {
    try {
      return await this.upload.uploadAll(media, signal)
    } catch (error) {
      throw toApiError(error, this.modelId)
    }
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

  /** Map canonical webchat events onto `LanguageModelV3StreamPart`s. */
  private buildStream(input: {
    generator: AsyncGenerator<WebChatEvent>
    warnings: SharedV3Warning[]
    signal?: AbortSignal
    onCancel?: () => void
  }): ReadableStream<LanguageModelV3StreamPart> {
    const { generator, warnings, signal, onCancel } = input
    const modelId = this.modelId
    let finished = false
    let toolCallCount = 0
    let blockCounter = 0
    let currentTextId: string | undefined
    let currentReasoningId: string | undefined
    let usage: LanguageModelV3Usage = emptyUsage()
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
    let metadataEmitted = false
    const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, "_")

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
    const ensureText = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentTextId === undefined) {
        currentTextId = `text-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "text-start", id: currentTextId })
      }
    }
    const ensureReasoning = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (currentReasoningId === undefined) {
        currentReasoningId = `reasoning-${safeId}-${++blockCounter}`
        controller.enqueue({ type: "reasoning-start", id: currentReasoningId })
      }
    }

    const finishStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
      if (finished) return
      finished = true
      endTextBlock(controller)
      endReasoningBlock(controller)
      const unified: "stop" | "tool-calls" = toolCallCount > 0 ? "tool-calls" : "stop"
      controller.enqueue({ type: "finish", finishReason: { unified, raw: unified }, usage })
      controller.close()
      debug("sdk", "generation finished", { model: modelId, toolCalls: toolCallCount })
    }

    const failStream = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, error: unknown) => {
      if (finished) return
      finished = true
      controller.error(toApiError(error, modelId))
    }

    return new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
        void (async () => {
          try {
            for (;;) {
              if (finished) return
              const { done, value } = await generator.next()
              if (finished) return
              if (done) {
                finishStream(controller)
                return
              }
              handleEvent(controller, value)
            }
          } catch (error) {
            if (finished) return
            if (isAbortLike(error) || signal?.aborted) failStream(controller, aborted())
            else failStream(controller, error)
          }
        })()
      },
      pull() {},
      cancel: () => {
        if (!finished) {
          finished = true
          onCancel?.()
          void generator.return(undefined).catch(() => {})
        }
      },
    })

    function handleEvent(
      controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      event: WebChatEvent,
    ): void {
      switch (event.type) {
        case "thinking-start":
          endTextBlock(controller)
          ensureReasoning(controller)
          return
        case "thinking-delta":
          ensureReasoning(controller)
          controller.enqueue({ type: "reasoning-delta", id: currentReasoningId as string, delta: event.delta })
          return
        case "thinking-end":
          endReasoningBlock(controller)
          return
        case "text-start":
          endReasoningBlock(controller)
          ensureText(controller)
          return
        case "text-delta":
          ensureText(controller)
          controller.enqueue({ type: "text-delta", id: currentTextId as string, delta: event.delta })
          return
        case "text-end":
          endTextBlock(controller)
          return
        case "tool-call":
          endTextBlock(controller)
          endReasoningBlock(controller)
          toolCallCount++
          controller.enqueue({
            type: "tool-call",
            toolCallId: event.id,
            toolName: event.name,
            input: JSON.stringify(event.args),
          })
          return
        case "usage":
          usage = mapCanonicalUsage(event.usage)
          return
        case "response-metadata":
          if (!metadataEmitted && event.responseId) {
            metadataEmitted = true
            controller.enqueue({ type: "response-metadata", id: event.responseId })
          }
          return
        case "finish":
          finishReason = { unified: event.finishReason, raw: event.finishReason }
          return
        case "done":
          return
        case "error":
          throw event.error
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

function mapCanonicalUsage(usage: WebChatUsage): LanguageModelV3Usage {
  return {
    inputTokens: { total: usage.inputTokens, noCache: undefined, cacheRead: usage.cacheRead, cacheWrite: undefined },
    outputTokens: { total: usage.outputTokens, text: usage.textTokens, reasoning: usage.reasoningTokens },
    raw: { totalTokens: usage.totalTokens },
  }
}

function aborted(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web request was aborted", retryable: false })
  error.name = "AbortError"
  return error
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