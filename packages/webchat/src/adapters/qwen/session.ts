/**
 * Qwen chat-session management.
 *
 * AlphaCode owns one persistent Qwen chat per thread (`ThreadStore`), and
 * every generation is an incremental turn on that chat: it chains the new
 * user message to the previous assistant response via `parent_id`, so the
 * model sees the conversation in its server-side memory instead of a
 * re-sent transcript. Tools are offered on each turn and parsed out of the
 * stream (`QWEN_WEB_TOOL_MODE=block`, the default) or surfaced as native
 * `local_mcp` `tool_calls` events (`QwenWebToolMode.native`, experimental).
 *
 * The thread is the source of truth for continuation anchors (`providerId`
 * = upstream chat, `providerState.responseId` = chain parent). Each turn
 * mutates the stored thread and re-persists it, so a restart reuses the
 * same upstream chat instead of creating a new one.
 */
import {
  QWEN_WEB_ENV,
  QWEN_WEB_PATHS,
  type QwenWebChatMode,
  type QwenWebReasoningMode,
  type QwenWebToolMode,
} from "./constants"
import {
  CHALLENGE_NO_WINDOW_DETAIL,
  CHALLENGE_WINDOW_OPEN_DETAIL,
  QwenWebError,
  abortedError,
  challengeError,
  classifyJsonError,
  classifyStatus,
  classifyStreamError,
  isAbortLike,
  isHtmlBody,
  isStallTimeout,
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
  randomId,
  type QwenNativeTool,
  type QwenWebFileEntry,
  type QwenWebStreamEvent,
} from "./protocol"
import { ThreadStore } from "../../store"
import { append, lastAnchored, removeById, byId } from "../../thread"
import { StreamingToolParser } from "./tool-parser"
import { QwenWebTransport, sharedTransport } from "./transport"
import type {
  WebChatEditInput,
  WebChatEvent,
  WebChatForkInput,
  WebChatMessage,
  WebChatPart,
  WebChatProvider,
  WebChatThread,
  WebChatTool,
  WebChatTurnInput,
  WebChatUsage,
} from "../../types"

export interface QwenWebSessionOptions {
  transport?: QwenWebTransport
  chatMode?: QwenWebChatMode
  /** Tool protocol selection; `block` (default) uses marker-tag tool blocks. */
  toolMode?: QwenWebToolMode
  /** Persistence for threads; defaults to the data dir. Tests inject a temp store. */
  store?: ThreadStore
}

/**
 * Challenge errors already passed through reveal+enrich. The same error
 * object can surface at several sites (pre-stream throw, setup-loop
 * rethrow), and the headed relaunch must run only once per error.
 */
const enrichedChallenges = new WeakSet<QwenWebError>()

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

/** One incremental turn on an existing thread. */
export interface QwenWebTurnInput extends WebChatTurnInput {
  files?: QwenWebFileEntry[]
  reasoningMode?: QwenWebReasoningMode
}

export class QwenWebSession implements WebChatProvider {
  readonly id = "qwen-web"
  private readonly transport: QwenWebTransport
  private readonly chatMode: QwenWebChatMode
  private readonly toolMode: QwenWebToolMode
  private readonly store: ThreadStore
  private readonly running = new Set<string>()

  constructor(options?: QwenWebSessionOptions) {
    this.transport = options?.transport ?? sharedTransport()
    this.chatMode = options?.chatMode ?? readChatModeDefault()
    this.toolMode = options?.toolMode ?? readToolModeDefault()
    this.store = options?.store ?? ThreadStore.inDataDir()
  }

  /** Create a fresh Qwen chat for one generation. */
  async createChat(model: string, signal?: AbortSignal): Promise<string> {
    const response = await this.transport.rawRequestJson("POST", QWEN_WEB_PATHS.chatsNew, {
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

  /** Start a streaming generation on a fresh chat (legacy single-turn path). */
  async startGeneration(input: StartGenerationInput): Promise<ActiveGeneration> {
    const signal = input.signal
    if (signal?.aborted) throw abortedError()
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
    // Completions run over the raw-node path: page-context fetches to this
    // endpoint are held by the WAF unless driven by the site's own client.
    const response = await this.transport.rawRequestStream("POST", path, {
      body: JSON.stringify(payload),
      signal,
      reasoning: input.reasoningMode !== "fast",
      referrer: chatReferrer(chatId),
    })
    await this.ensureStreamable(response, chatId, signal)
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

  // -------------------------------------------------------------------------
  // Persistent-thread API (`WebChatProvider`)
  // -------------------------------------------------------------------------

  /** Create a new (empty) thread. The upstream chat is created on first turn. */
  async createThread(input: { model: string; title?: string; scope?: string }): Promise<WebChatThread> {
    const now = Date.now()
    const thread: WebChatThread = {
      id: `qwen-web:${input.model}${input.scope ? `:${input.scope}` : ""}:${randomId()}`,
      model: input.model,
      title: input.title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    this.store.put(thread)
    return thread
  }

  /**
   * Return the persistent thread for a model (+optional scope, e.g. a per-agent
   * `threadId`). Multiple parallel agents on the same model share one thread,
   * so concurrent turns on the same thread are rejected (`busy`).
   */
  async ensureThread(input: { model: string; scope?: string }): Promise<WebChatThread> {
    const key = `qwen-web:${input.model}${input.scope ? `:${input.scope}` : ""}`
    const existing = this.store.get(key)
    if (existing) return existing
    const now = Date.now()
    const thread: WebChatThread = { id: key, model: input.model, messages: [], createdAt: now, updatedAt: now }
    this.store.put(thread)
    return thread
  }

  /**
   * Run one incremental turn on a thread. Yields canonical events; the last
   * one is `done` with the persisted thread. The turn chains onto the last
   * assistant response (`parent_id`) so upstream memory is the transcript.
   */
  async *runTurn(input: QwenWebTurnInput): AsyncGenerator<WebChatEvent> {
    const thread = input.thread
    const signal = input.signal
    const model = thread.model
    if (signal?.aborted) throw abortedError()
    if (this.running.has(thread.id)) {
      throw new QwenWebError({
        code: "upstream_error",
        retryable: true,
        message: `Qwen thread "${thread.id}" already has a turn in progress.`,
      })
    }
    this.running.add(thread.id)

    const traceStart = Date.now()
    const trace = (label: string, extra?: Record<string, unknown>) =>
      debug("session", `turn timing: ${label}`, { ms: Date.now() - traceStart, ...extra })

    const toolMode = this.toolMode
    const tools = input.tools ?? []
    const declaredTools = new Set(tools.map((tool) => tool.name))
    const nativeTools = toolMode === "native" ? toNativeTools(tools) : undefined

    // A fork/compaction seed becomes part of the first turn on the new chat.
    let content = input.content
    if (thread.seedText && !lastAnchored(thread)) {
      content = `${thread.seedText}\n\n${content}`
      thread.seedText = undefined
    }

    // The local mirror records the user node now; its id is the upstream fid.
    const fid = randomId()
    append(thread, {
      id: fid,
      role: "user",
      content,
      parts: [{ type: "text", text: content }],
    })
    this.store.put(thread)

    let chatId = thread.providerId
    let response:
      | { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void }
      | undefined
    let listener: (() => void) | undefined

    try {
      // Pre-stream setup is retried once; failures here cannot have produced
      // upstream output, so a retry cannot duplicate a generation.
      let setupError: unknown
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const chatCreatedNow = !chatId
          if (!chatId) {
            chatId = thread.providerId ?? (await this.createChat(model, signal))
            thread.providerId = chatId
            this.store.put(thread)
          }
          trace("chat ready", { created: chatCreatedNow })
          const parentId = (lastAnchored(thread)?.providerState?.responseId as string | undefined) ?? null
          const payload = buildCompletionPayload({
            prompt: content,
            model,
            chatId,
            parentId,
            files: input.files,
            reasoningMode: input.reasoningMode,
            chatMode: this.chatMode,
            toolMode,
            nativeTools,
          })
          const path = `${QWEN_WEB_PATHS.completions}?chat_id=${encodeURIComponent(chatId)}`
          const streamResponse = await this.transport.rawRequestStream("POST", path, {
            body: JSON.stringify(payload),
            signal,
            reasoning: (input.reasoningMode ?? "auto") !== "fast",
            referrer: chatReferrer(chatId),
          })
          trace("request sent")
          await this.ensureStreamable(streamResponse, chatId, signal)
          trace("response usable")
          response = streamResponse
          break
        } catch (error) {
          setupError = error
          if (attempt === 2 || !isPreStreamRetryable(error)) break
          debug("session", "turn setup failed; retrying once", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (!response) {
        // The user node was never delivered upstream: roll it back.
        removeById(thread, fid)
        this.store.put(thread)
        if (QwenWebError.isInstance(setupError) && setupError.code === "challenge") {
          throw await this.enrichChallenge(setupError, signal)
        }
        throw setupError
      }

      const parser = new StreamingToolParser({ declared: declaredTools })
      const sse = new QwenWebSSEParser()
      const decoder = new TextDecoder()
      const reader = response.stream.getReader()
      let responseId: string | undefined
      let textAccumulated = ""
      let reasoningAccumulated = ""
      let stopping = false
      let upstreamDone = false
      let toolCallCount = 0
      let usage: WebChatUsage | undefined
      let thinkingOpen = false
      let textOpen = false
      let firstChunkSeen = false
      let firstEventSeen = false
      let deltaLogged = false
      const traceFirstDelta = (kind: string): void => {
        if (deltaLogged) return
        deltaLogged = true
        trace(`first delta (${kind})`)
      }
      const textParts: string[] = []
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

      const stopUpstream = () => {
        if (stopping) return
        stopping = true
        void this.stopGeneration(chatId!, responseId, () => response!.abort()).catch(() => {})
      }
      const onAbort = () => stopUpstream()
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
        listener = onAbort
      }

      const endThinking = function* (): Generator<WebChatEvent> {
        if (thinkingOpen) {
          thinkingOpen = false
          yield { type: "thinking-end" }
        }
      }
      const endText = function* (): Generator<WebChatEvent> {
        if (textOpen) {
          textOpen = false
          yield { type: "text-end" }
        }
      }

      const emitToolCall = function* (id: string, name: string, args: unknown): Generator<WebChatEvent> {
        yield* endThinking()
        yield* endText()
        toolCallCount++
        toolCalls.push({ id, name, args })
        yield { type: "tool-call", id, name, args }
      }

      const handleEvent = function* (event: QwenWebStreamEvent): Generator<WebChatEvent> {
        switch (event.kind) {
          case "done":
          case "answer-finished":
            upstreamDone = true
            return
          case "response-created":
            if (!responseId) {
              responseId = event.responseId
              yield { type: "response-metadata", responseId: event.responseId }
            }
            return
          case "error":
            throw classifyStreamError(event.code, event.message)
          case "usage":
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.totalTokens,
              cacheRead: event.cachedTokens,
              reasoningTokens: event.reasoningTokens,
              textTokens: event.textTokens,
            }
            yield { type: "usage", usage }
            return
          case "tool-calls": {
            // Experimental native path: delta `tool_calls` arrivals, one call
            // per event. Partial-argument accumulation is not attempted.
            if (responseId && event.responseId && event.responseId !== responseId) return
            for (const call of event.calls) {
              yield* emitToolCall(call.id ?? `call_${randomId()}`, call.name ?? "unknown", parseToolArgs(call.arguments))
            }
            return
          }
          case "thinking": {
            if (responseId && event.responseId && event.responseId !== responseId) return
            const formatted = formatThinkingSummary(event.delta)
            if (!formatted) return
            const result = incrementalDelta(reasoningAccumulated, formatted)
            if (result.delta === "FINISHED") return
            reasoningAccumulated = result.matched
            if (!result.delta) return
            if (!thinkingOpen) {
              thinkingOpen = true
              yield* endText()
              traceFirstDelta("thinking")
              yield { type: "thinking-start" }
            }
            yield { type: "thinking-delta", delta: result.delta }
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
            if (parsed.text) {
              if (!textOpen) {
                textOpen = true
                yield* endThinking()
                yield { type: "text-start" }
              }
              textParts.push(parsed.text)
              traceFirstDelta("text")
              yield { type: "text-delta", delta: parsed.text }
            }
            for (const call of parsed.toolCalls) {
              yield* emitToolCall(call.id, call.name, parseToolArgs(call.input))
            }
            return
          }
          case "unknown":
            return
        }
      }

      let failure: unknown
      try {
        for (;;) {
          if (signal?.aborted) throw abortedError()
          const { done, value } = await reader.read()
          if (done || !value) break
          if (!firstChunkSeen) {
            firstChunkSeen = true
            trace("first chunk")
          }
          const events = sse.feed(decoder.decode(value, { stream: true }))
          for (const event of events) {
            if (upstreamDone) break
            if (!firstEventSeen) {
              firstEventSeen = true
              trace("first event", { kind: event.kind })
            }
            yield* handleEvent(event)
          }
          if (upstreamDone) break
        }
        if (!upstreamDone) {
          const tail = decoder.decode()
          const events = [...(tail ? sse.feed(tail) : []), ...sse.flush()]
          for (const event of events) {
            if (upstreamDone) break
            yield* handleEvent(event)
          }
        }
      } catch (error) {
        if (QwenWebError.isInstance(error) && error.code === "challenge") {
          // Mid-stream challenge: open a visible window when possible, and
          // say exactly what happened instead of promising a window.
          failure = await this.enrichChallenge(error, signal)
        } else if (isAbortLike(error) || signal?.aborted) {
          failure = abortedError()
        } else if (isStallTimeout(error)) {
          // The upstream went quiet without a terminating event. Recover the
          // unclosed tail and end gracefully so tool calls already emitted are
          // still usable instead of the turn wedging forever.
          stopUpstream()
        } else {
          failure = error
        }
      }

      const graceful = !failure || isStallTimeout(failure)
      if (graceful) {
        const flushed = parser.flush()
        if (flushed.text) {
          if (!textOpen) {
            textOpen = true
            yield* endThinking()
            yield { type: "text-start" }
          }
          textParts.push(flushed.text)
          yield { type: "text-delta", delta: flushed.text }
        }
        for (const call of flushed.toolCalls) {
          yield* emitToolCall(call.id, call.name, parseToolArgs(call.input))
        }
        yield* endThinking()
        yield* endText()
        const finishReason: "stop" | "tool-calls" = toolCallCount > 0 ? "tool-calls" : "stop"
        yield { type: "finish", finishReason }
        append(
          thread,
          buildAssistantMessage({
            responseId,
            text: textAccumulated,
            textParts,
            toolCalls,
            usage,
            createdAt: Date.now(),
          }),
        )
      } else {
        yield* endThinking()
        yield* endText()
        yield { type: "error", error: failure }
      }
      this.store.put(thread)
      trace("turn done", { failure: Boolean(failure) })
      yield { type: "done", thread }
    } finally {
      this.running.delete(thread.id)
      if (listener && signal) signal.removeEventListener("abort", listener)
    }
  }

  /**
   * Rewrite a message's content in place. Editing a user node keeps its id, so
   * future forks/anchors stay stable; the server-side rewrite is best-effort
   * (wire validation is a separate spike), so this is marked on the node.
   */
  async editMessage(input: WebChatEditInput): Promise<WebChatThread> {
    const { thread, messageId, content } = input
    const message = byId(thread, messageId)
    if (!message) {
      throw new QwenWebError({
        code: "invalid_response",
        retryable: false,
        message: `Cannot edit message "${messageId}": not part of the thread.`,
      })
    }
    message.content = content
    message.parts = [{ type: "text", text: content }, ...message.parts.filter((part) => part.type !== "text")]
    message.providerState = { ...message.providerState, editedLocally: true }
    thread.updatedAt = Date.now()
    this.store.put(thread)
    debug("session", "edited message (local mirror; server-side write pending wire validation)", {
      thread: thread.id,
      messageId,
    })
    return thread
  }

  /** Fork a thread into a new empty chat; `seed` seeds the first turn. */
  async forkThread(input: WebChatForkInput): Promise<WebChatThread> {
    const now = Date.now()
    const thread: WebChatThread = {
      id: `qwen-web:${input.thread.model}:fork:${randomId()}`,
      model: input.thread.model,
      title: input.thread.title ? `${input.thread.title} (fork)` : undefined,
      seedText: input.seed,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    this.store.put(thread)
    debug("session", "forked thread", { from: input.thread.id, to: thread.id, seed: Boolean(input.seed) })
    return thread
  }

  /** Local threads are authoritative for AlphaCode's own turns; the upstream
   * reconcile (`GET chat`) is a separate wire spike. */
  async readThread(input: { thread: WebChatThread }): Promise<WebChatThread> {
    return this.store.get(input.thread.id) ?? input.thread
  }

  /** Drop the local thread. The upstream chat delete is a separate spike. */
  async deleteThread(input: { thread: WebChatThread }): Promise<void> {
    debug("session", "deleted thread (local); upstream chat delete is a separate spike", { thread: input.thread.id })
    this.store.remove(input.thread.id)
  }

  /** The shared browser/transport own their lifecycle; nothing to release. */
  async stop(): Promise<void> {
    debug("session", "stop() called; shared transport lifecycle owned elsewhere", {})
  }

  /** Reveal a headed window for a challenge; returns the detail naming what happened. */
  private async challengeDetail(signal?: AbortSignal): Promise<string> {
    const revealed = await this.transport.revealChallengeWindow(signal).catch(() => false)
    return revealed ? CHALLENGE_WINDOW_OPEN_DETAIL : CHALLENGE_NO_WINDOW_DETAIL
  }

  /**
   * Attach the reveal detail to a challenge error exactly once. The same
   * error object can pass several sites (pre-stream throw -> setup-loop
   * rethrow), and the reveal (headed relaunch) must run only once.
   */
  private async enrichChallenge(error: QwenWebError, signal?: AbortSignal): Promise<QwenWebError> {
    if (enrichedChallenges.has(error)) return error
    enrichedChallenges.add(error)
    error.message += ` ${await this.challengeDetail(signal)}`
    return error
  }

  private async ensureStreamable(
    response: { status: number; contentType: string; stream: ReadableStream<Uint8Array>; abort: () => void },
    chatId: string,
    signal?: AbortSignal,
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
      if (isWafMessage(preview)) throw await this.enrichChallenge(challengeError(), signal)
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
  const raw = process.env[QWEN_WEB_ENV.chatMode]?.toLowerCase()
  if (raw === "thread" || raw === "thread-explicit") {
    debug("session", "THREAD MODE ENABLED — shares upstream Qwen conversation across turns. This can leak context between unrelated AlphaCode sessions using the same Qwen account. Use QWEN_WEB_CHAT_MODE=thread-explicit to acknowledge.")
  }
  return raw === "thread-explicit" ? "thread" : "temp"
}

function readToolModeDefault(): QwenWebToolMode {
  return process.env[QWEN_WEB_ENV.toolMode]?.toLowerCase() === "native" ? "native" : "block"
}

function isPreStreamRetryable(error: unknown): boolean {
  if (isAbortLike(error)) return false
  if (!QwenWebError.isInstance(error)) return false
  if (error.code === "login_required" || error.code === "session_expired" || error.code === "challenge") return false
  return error.retryable
}

function parseToolArgs(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function toNativeTools(tools: WebChatTool[]): QwenNativeTool[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
  }))
}

function buildAssistantMessage(input: {
  responseId?: string
  text: string
  textParts: string[]
  toolCalls: Array<{ id: string; name: string; args: unknown }>
  usage?: WebChatUsage
  createdAt: number
}): WebChatMessage {
  const parts: WebChatPart[] = []
  if (input.textParts.length > 0) parts.push({ type: "text", text: input.textParts.join("") })
  for (const call of input.toolCalls) parts.push({ type: "tool-call", id: call.id, name: call.name, args: call.args })
  const message: WebChatMessage = {
    id: `assistant-${randomId()}`,
    role: "assistant",
    content: input.text,
    parts,
    createdAt: input.createdAt,
  }
  if (input.responseId) message.providerState = { responseId: input.responseId }
  else message.providerState = { usage: input.usage }
  return message
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
      if (signal?.aborted) throw abortedError()
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