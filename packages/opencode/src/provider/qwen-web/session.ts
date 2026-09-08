/**
 * Qwen chat-session management.
 *
 * Each AlphaCode generation runs on a fresh Qwen chat (ephemeral `local`
 * chats by default, so the user's chat list is never polluted). AlphaCode
 * owns the conversation history and re-sends the full transcript every turn;
 * no server-side thread state is reused, which keeps concurrent generations
 * isolated and cancellation trivial.
 */
import { QWEN_WEB_ENV, QWEN_WEB_PATHS, type QwenWebChatMode, type QwenWebReasoningMode } from "./constants"
import {
  QwenWebError,
  challengeError,
  classifyJsonError,
  classifyStatus,
  isHtmlBody,
  isWafMessage,
  loginRequiredError,
  sessionExpiredError,
} from "./errors"
import { debug, summarizePayload } from "./log"
import {
  buildChatNewBody,
  buildCompletionPayload,
  buildStopBody,
  formatThinkingSummary,
  incrementalDelta,
  parseChatNewResponse,
  QwenWebSSEParser,
  type QwenWebFileEntry,
  type QwenWebStreamEvent,
} from "./protocol"
import { QwenWebTransport, sharedTransport } from "./transport"

export interface QwenWebSessionOptions {
  transport?: QwenWebTransport
  chatMode?: QwenWebChatMode
}

export interface StartGenerationInput {
  prompt: string
  model: string
  files?: QwenWebFileEntry[]
  reasoningMode?: QwenWebReasoningMode
  signal?: AbortSignal
  referrerChatId?: string | null
}

export interface ActiveGeneration {
  chatId: string
  response: { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void }
}

export class QwenWebSession {
  private readonly transport: QwenWebTransport
  private readonly chatMode: QwenWebChatMode

  constructor(options?: QwenWebSessionOptions) {
    this.transport = options?.transport ?? sharedTransport()
    this.chatMode = options?.chatMode ?? readChatModeDefault()
  }

  /** Create a fresh Qwen chat for one generation. */
  async createChat(model: string, signal?: AbortSignal): Promise<string> {
    const response = await this.transport.requestJson("POST", QWEN_WEB_PATHS.chatsNew, {
      body: JSON.stringify(buildChatNewBody(model, this.chatMode)),
      signal,
    })
    if (response.status === 401 || response.status === 403) throw sessionExpiredError()
    if (response.status < 200 || response.status >= 300) {
      throw classifyJsonError(response.body, response.status) ?? classifyStatus(response.status) ?? loginRequiredError()
    }
    const chatId = parseChatNewResponse(safeJsonParse(response.body))
    if (!chatId) {
      const classified = classifyJsonError(response.body, response.status)
      if (classified) throw classified
      throw new QwenWebError({
        code: "invalid_response",
        retryable: false,
        status: response.status,
        message: "Qwen returned an unexpected chat-creation payload.",
      })
    }
    debug("session", "chat created", { chatId: chatId.slice(0, 12), ...summarizePayload(JSON.stringify({ model })) })
    return chatId
  }

  /** Start a streaming generation on a fresh chat. */
  async startGeneration(input: StartGenerationInput): Promise<ActiveGeneration> {
    const signal = input.signal
    if (signal?.aborted) throw aborted()
    const chatId = await this.createChat(input.model, signal)
    const payload = buildCompletionPayload({
      prompt: input.prompt,
      model: input.model,
      chatId,
      parentId: null,
      files: input.files,
      reasoningMode: input.reasoningMode,
      chatMode: this.chatMode,
    })
    const path = `${QWEN_WEB_PATHS.completions}?chat_id=${encodeURIComponent(chatId)}`
    const response = await this.transport.requestStream("POST", path, {
      body: JSON.stringify(payload),
      signal,
      reasoning: input.reasoningMode !== "fast",
      referrer: chatReferrer(chatId),
    })
    await this.ensureStreamable(response, chatId)
    return { chatId, response }
  }

  /**
   * Ask the upstream to stop an in-flight generation, then abort locally.
   * Best effort: cancelling the local stream always proceeds.
   */
  async stopGeneration(chatId: string, responseId: string | undefined, abortLocal: () => void): Promise<void> {
    try {
      if (responseId) {
        const path = `${QWEN_WEB_PATHS.completionsStop}?chat_id=${encodeURIComponent(chatId)}`
        await this.transport
          .requestJson("POST", path, {
            body: JSON.stringify(buildStopBody(chatId, responseId)),
            referrer: chatReferrer(chatId),
            timeoutMs: 15_000,
          })
          .catch(() => undefined)
      }
    } finally {
      abortLocal()
    }
  }

  private async ensureStreamable(
    response: { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void },
    chatId: string,
  ): Promise<void> {
    const contentType = response.contentType.toLowerCase()
    if (
      response.status >= 200 &&
      response.status < 300 &&
      (contentType.includes("text/event-stream") || contentType === "")
    )
      return
    // Non-streaming response: drain a bounded preview to classify the failure.
    const preview = await readPreview(response.stream, 8192).catch(() => "")
    response.abort()
    debug("session", "non-SSE completion response", {
      chatId: chatId.slice(0, 12),
      status: response.status,
      contentType,
    })
    if (isWafMessage(preview) || isHtmlBody(preview) || contentType.includes("text/html")) {
      if (isWafMessage(preview)) throw challengeError()
      throw sessionExpiredError("Qwen returned a login page instead of a stream.")
    }
    if (contentType.includes("application/json") || preview.trimStart().startsWith("{")) {
      throw classifyJsonError(preview, response.status) ?? classifyStatus(response.status) ?? loginRequiredError()
    }
    throw classifyStatus(response.status) ?? loginRequiredError()
  }
}

function chatReferrer(chatId: string): string {
  return `/c/${encodeURIComponent(chatId)}`
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

async function readPreview(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      bytes += value.byteLength
      if (bytes >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function readChatModeDefault(): QwenWebChatMode {
  return process.env[QWEN_WEB_ENV.chatMode]?.toLowerCase() === "thread" ? "thread" : "temp"
}

function aborted(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web request was aborted", retryable: false })
  error.name = "AbortError"
  return error
}

// ---------------------------------------------------------------------------
// Stream consumption: SSE events -> ordered text / reasoning / usage deltas.
// ---------------------------------------------------------------------------

export interface ConsumedStream {
  text: string
  reasoning: string
  responseId?: string
  chatId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    textTokens?: number
  }
  finishReason: "stop" | "length" | "error"
  error?: QwenWebError
}

export interface StreamConsumerEvents {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onResponseCreated?: (responseId: string, chatId?: string) => void
  onUsage?: (usage: NonNullable<ConsumedStream["usage"]>) => void
}

/**
 * Consume a raw upstream byte stream into ordered deltas.
 *
 * Cumulative `content` updates are prefix-diffed; a `FINISHED` sentinel and
 * empty deltas are swallowed; only events for the first observed response id
 * are honored (the upstream may interleave auxiliary streams).
 */
export async function consumeQwenStream(
  stream: ReadableStream<Uint8Array>,
  events?: StreamConsumerEvents,
  signal?: AbortSignal,
): Promise<ConsumedStream> {
  const parser = new QwenWebSSEParser()
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ""
  let reasoning = ""
  let responseId: string | undefined
  let chatId: string | undefined
  let usage: ConsumedStream["usage"]
  let streamError: QwenWebError | undefined
  let terminated = false

  const handle = (event: QwenWebStreamEvent): void => {
    switch (event.kind) {
      case "done":
      case "answer-finished":
        terminated = true
        return
      case "response-created":
        if (!responseId) responseId = event.responseId
        if (event.chatId) chatId = event.chatId
        events?.onResponseCreated?.(event.responseId, event.chatId)
        return
      case "error":
        streamError =
          classifyJsonError(JSON.stringify({ error: { code: event.code, message: event.message } }), 200) ??
          new QwenWebError({
            code: "upstream_error",
            retryable: true,
            upstreamCode: event.code,
            message: `Qwen stream error: ${event.message.slice(0, 300)}`,
          })
        terminated = true
        return
      case "usage":
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cachedTokens: event.cachedTokens,
          reasoningTokens: event.reasoningTokens,
          textTokens: event.textTokens,
        }
        events?.onUsage?.(usage)
        return
      case "thinking": {
        if (responseId && event.responseId && event.responseId !== responseId) return
        const formatted = formatThinkingSummary(event.delta)
        if (!formatted) return
        const result = incrementalDelta(reasoning, formatted)
        if (result.delta === "FINISHED") return
        reasoning = result.matched
        if (result.delta) events?.onReasoning?.(result.delta)
        return
      }
      case "text": {
        if (responseId && event.responseId && event.responseId !== responseId) return
        if (event.responseId && !responseId) responseId = event.responseId
        const result = incrementalDelta(text, event.content)
        if (result.delta === "FINISHED") return
        text = result.matched
        if (result.delta) events?.onText?.(result.delta)
        return
      }
      case "unknown":
        return
    }
  }

  try {
    for (;;) {
      if (signal?.aborted) throw aborted()
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const events = parser.feed(decoder.decode(value, { stream: true }))
      for (const event of events) {
        handle(event)
        if (terminated) break
      }
      if (terminated) break
    }
    if (!terminated) {
      const tail = decoder.decode()
      const events = [...(tail ? parser.feed(tail) : []), ...parser.flush()]
      for (const event of events) {
        handle(event)
        if (terminated) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  if (streamError) {
    return { text, reasoning, responseId, chatId, usage, finishReason: "error", error: streamError }
  }
  return { text, reasoning, responseId, chatId, usage, finishReason: "stop" }
}
