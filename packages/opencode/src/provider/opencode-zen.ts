/**
 * Adapter for the OpenCode Zen gateway (`https://opencode.ai/zen/v1`).
 *
 * Zen only serves its free tier (`deepseek-v4-flash-free`, `big-pickle`,
 * `mimo-v2.5-free`, ...) to clients that identify themselves as the OpenCode
 * CLI, so requests from a plain HTTP client are rejected before the model runs:
 *
 * - a missing `x-opencode-session` is rejected with `400 MissingSessionID`,
 * - standard library/OpenAI SDK user agents are rejected with
 *   `403 FreeTierError`,
 * - free models only accept `Authorization: Bearer public`; a regular `sk-*`
 *   key without a billing account attached is rejected,
 * - non-streaming calls (`{"stream": false}`) are rejected,
 * - payloads without any tool definition are rejected.
 *
 * `createFetch` is installed as the provider fetch for the `opencode` provider,
 * so it observes the exact request the AI SDK would send and can satisfy that
 * contract: client/session/request headers are added, free models are
 * authenticated with the public bearer token, `stream: true` is enforced with
 * the SSE response re-assembled into the JSON completion the caller expected,
 * and an empty tool list gets a placeholder definition.
 *
 * Requests the adapter does not rewrite (anything without a chat completion
 * body) are forwarded untouched, including their body bytes, method, signal,
 * and Request options.
 */

import { isRecord } from "@/util/record"
import { ProviderError } from "./error"

/**
 * User agent the gateway accepts. Anything else is treated as an untrusted
 * client, so this is pinned to the versions the CLI ships with rather than
 * derived from the build: the workspace version does not identify a released
 * CLI (dev builds report `opencode/local`) and the AI SDK and runtime tokens
 * would drift with whatever is installed. Update this string as a contract
 * change, together with a check against the gateway, not automatically.
 */
export const ZEN_USER_AGENT = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"

/** The free tier authenticates as the public client; paid keys require a billing account. */
export const ZEN_PUBLIC_AUTHENTICATION = "Bearer public"

const ZEN_PLACEHOLDER_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description: "Do not call this tool. It exists only to satisfy the gateway tool schema.",
    parameters: { type: "object", properties: {} },
  },
}

/** UUID source, injectable so callers and tests can control id generation. */
export type UUID = () => string

const randomUUID: UUID = () => crypto.randomUUID()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Session ids the workspace itself generates: 12 hex timestamp characters
 * followed by 14 base 62 characters (`Identifier.create`).
 */
const WORKSPACE_SESSION_PATTERN = /^[0-9a-f]{12}[0-9a-zA-Z]{14}$/

/**
 * Session ids stay stable for one conversation thread; request ids change
 * every turn.
 *
 * Zen documents the header as `ses_<uuid>`, while a conversation id generated
 * by this workspace is `ses_` plus an identifier, not a UUID, so both shapes
 * are accepted. Anything else (`ses_invalid`, an unrelated string) is replaced
 * with a generated id instead of being forwarded.
 */
export function sessionID(value: string | undefined, uuid: UUID = randomUUID) {
  const id = value?.startsWith("ses_") ? value.slice("ses_".length) : value
  if (id === undefined || (!UUID_PATTERN.test(id) && !WORKSPACE_SESSION_PATTERN.test(id))) return `ses_${uuid()}`
  return `ses_${id}`
}

/** Request ids are regenerated for every provider turn. */
export function requestID(uuid: UUID = randomUUID) {
  return `msg_${uuid()}`
}

type Chunk = {
  id?: string
  created?: number
  model?: string
  usage?: unknown
  error?: unknown
  choices?: ReadonlyArray<{
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: ReadonlyArray<{
        index?: number | null
        id?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }>
    }
    finish_reason?: string | null
  }>
}

type Frame = { readonly chunk: Chunk } | { readonly done: true }

type Cost = {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Cost metadata of a catalog model, including its context-priced tiers. */
export type ModelCost = Cost & {
  readonly tiers?: ReadonlyArray<Cost>
  readonly experimentalOver200K?: Cost
}

export function zeroCost(cost: ModelCost) {
  const entries = [cost, ...(cost.tiers ?? []), ...(cost.experimentalOver200K ? [cost.experimentalOver200K] : [])]
  return entries.every(
    (entry) => entry.input === 0 && entry.output === 0 && entry.cache.read === 0 && entry.cache.write === 0,
  )
}

/**
 * Wire model ids Zen serves for free.
 *
 * The gateway reads the request's `model` field, which the AI SDK fills from
 * the model's API id, so the set has to be keyed by that id: a config alias
 * must not hide a free model, and an alias for a paid model must not unlock
 * the public token. Only models whose complete cost metadata (every component,
 * including context tiers) is zero qualify — a zero input price with priced
 * output is not a free model.
 */
export function freeTier(models: Iterable<{ readonly api: { readonly id: string }; readonly cost: ModelCost }>) {
  return new Set([...models].filter((model) => zeroCost(model.cost)).map((model) => model.api.id))
}

function parsed(data: string): Chunk | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  return isRecord(value) ? (value as Chunk) : undefined
}

function streamError(value: unknown) {
  const detail = isRecord(value) && typeof value["message"] === "string" ? value["message"] : JSON.stringify(value)
  return new ProviderError.ResponseStreamError(`Zen stream error: ${detail}`)
}

function stallError(chunkTimeout: number) {
  return new ProviderError.ResponseStreamError(`Zen stream stalled for more than ${chunkTimeout}ms`)
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")
}

/**
 * Reject a pending read as soon as the caller aborts. `AbortSignal` listeners
 * never fire for a signal that is already aborted, and an upstream that
 * ignores the abort would otherwise leave the read hanging forever.
 */
function abortWatch(signal: AbortSignal) {
  let fail: (reason: unknown) => void = () => {}
  const promise = new Promise<never>((_, reject) => {
    fail = reject
  })
  const listener = () => fail(abortReason(signal))
  if (signal.aborted) listener()
  else signal.addEventListener("abort", listener, { once: true })
  void promise.catch(() => {})
  return { promise, clear: () => signal.removeEventListener("abort", listener) }
}

function read(reader: ReadableStreamDefaultReader<Uint8Array>, chunkTimeout: number | undefined) {
  if (chunkTimeout === undefined || chunkTimeout <= 0) return reader.read()
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = stallError(chunkTimeout)
      void reader.cancel(error).catch(() => {})
      reject(error)
    }, chunkTimeout)
    reader.read().then(
      (part) => {
        clearTimeout(timer)
        resolve(part)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Read SSE frames incrementally so a stalled or aborted upstream rejects with
 * the same response-stream error the provider's own SSE reader raises, instead
 * of hanging until the whole body is buffered.
 */
async function* frames(response: Response, input: AggregateInput): AsyncGenerator<Frame> {
  const reader = response.body?.getReader()
  if (!reader) return
  const signal = input.signal
  const decoder = new TextDecoder()
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {})
  const watch = signal ? abortWatch(signal) : undefined
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) {
      cancel()
      throw abortReason(signal)
    }
    let buffer = ""
    while (true) {
      const pending = read(reader, input.chunkTimeout)
      const part = await (watch ? Promise.race([pending, watch.promise]) : pending)
      if (part.done) break
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const frame = parseFrame(line)
        if (!frame) continue
        yield frame
        if ("done" in frame) return
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
    watch?.clear()
    await reader.cancel().catch(() => {})
  }
}

function parseFrame(line: string): Frame | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) return undefined
  const data = trimmed.slice("data:".length).trim()
  if (data.length === 0) return undefined
  if (data === "[DONE]") return { done: true }
  const chunk = parsed(data)
  return chunk === undefined ? undefined : { chunk }
}

export type AggregateInput = {
  readonly signal?: AbortSignal | null
  /** Milliseconds to wait for the next SSE chunk before failing the read. */
  readonly chunkTimeout?: number
}

/** Re-assemble a streamed completion into the JSON response a non-streaming caller expects. */
async function aggregate(response: Response, input: AggregateInput) {
  const state = {
    id: undefined as string | undefined,
    created: undefined as number | undefined,
    model: undefined as string | undefined,
    finish: undefined as string | undefined,
    usage: undefined as unknown,
    content: "",
    reasoning: "",
    reasoningContent: "",
    calls: new Map<number, { id: string | undefined; name: string; arguments: string }>(),
  }

  let completed = false
  for await (const frame of frames(response, input)) {
    if ("done" in frame) {
      completed = true
      break
    }
    const chunk = frame.chunk
    if (chunk.error !== undefined) throw streamError(chunk.error)
    if (chunk.id !== undefined) state.id = chunk.id
    if (chunk.created !== undefined) state.created = chunk.created
    if (chunk.model !== undefined) state.model = chunk.model
    if (chunk.usage !== undefined) state.usage = chunk.usage

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) state.content += delta.content
    if (delta?.reasoning) state.reasoning += delta.reasoning
    if (delta?.reasoning_content) state.reasoningContent += delta.reasoning_content
    delta?.tool_calls?.forEach((call, position) => {
      // Streaming deltas address a call by `index`; fragments for two calls can
      // arrive interleaved, so the position inside one delta cannot key them.
      const key = call.index ?? position
      const current = state.calls.get(key) ?? { id: undefined, name: "", arguments: "" }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.arguments += call.function.arguments
      state.calls.set(key, current)
    })
    if (choice?.finish_reason) state.finish = choice.finish_reason
  }

  // A stream that stops without a finish reason or a `[DONE]` frame was cut
  // short; reporting it as a normal completion would hide real failures.
  if (!completed && state.finish === undefined) {
    throw new ProviderError.ResponseStreamError("Zen stream ended before the completion finished")
  }

  const message: Record<string, unknown> = { role: "assistant", content: state.content }
  if (state.reasoningContent) message["reasoning_content"] = state.reasoningContent
  if (state.reasoning) message["reasoning"] = state.reasoning
  if (state.calls.size > 0) {
    message["tool_calls"] = [...state.calls.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
  }

  return new Response(
    JSON.stringify({
      id: state.id,
      object: "chat.completion",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, message, finish_reason: state.finish ?? null }],
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    }),
    { status: response.status, headers: { "content-type": "application/json" } },
  )
}

function pathname(url: string) {
  try {
    return new URL(url, "http://localhost").pathname
  } catch {
    return url
  }
}

/**
 * Chat completion endpoints follow the OpenAI protocol. Anthropic native
 * requests (e.g. on `/messages` or with Anthropic headers) also contain a
 * `messages` array, but must be left untouched so the adapter does not inject
 * an invalid tool schema or fail their streaming events.
 */
function isChatCompletion(url: string, headers: Headers) {
  const path = pathname(url)
  if (path.endsWith("/messages") || headers.has("anthropic-version") || headers.has("anthropic-beta")) {
    return false
  }
  return path.endsWith("/chat/completions")
}

/** Chat completion payloads are the only Zen requests the adapter rewrites. */
function chatRequest(url: string, headers: Headers, body: string | undefined): Record<string, unknown> | undefined {
  if (!isChatCompletion(url, headers)) return undefined
  if (body === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !Array.isArray(value["messages"])) return undefined
  return value
}

/**
 * The body fetch would actually send: `init.body` overrides a `Request` body,
 * including an explicit `null`, which removes it. Only text-like bodies are
 * readable; streams, `FormData`, and binary payloads of unknown shape stay
 * untouched so they cannot be corrupted by a decode.
 */
async function bodyText(input: RequestInfo | URL, init: RequestInit | undefined) {
  const body = init?.body
  if (body === null) return undefined
  if (body !== undefined) {
    if (typeof body === "string") return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
    return undefined
  }
  if (input instanceof Request && (input.headers.get("content-type") ?? "").includes("json")) {
    return input.clone().text()
  }
  return undefined
}

/** Request options that `fetch(url, init)` would otherwise lose when a Request becomes a URL. */
function requestOptions(request: Request | undefined, init: RequestInit | undefined): RequestInit {
  if (!request) return init ?? {}
  return {
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    ...init,
  }
}

/** Transport seam so callers that already wrap fetch (and tests) can reuse the adapter. */
export type ZenFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export type FetchInput = {
  /** Model ids Zen serves for free; these must authenticate as the public client. */
  readonly free?: ReadonlySet<string>
  /** Milliseconds to wait for the next SSE chunk while re-assembling a stream. */
  readonly chunkTimeout?: number
  readonly upstream?: ZenFetch
  /** UUID source; injected by tests. */
  readonly uuid?: UUID
}

/**
 * Wrap a fetch so every chat completion routed to the Zen gateway carries the
 * client contract Zen verifies before running a request.
 */
export function createFetch(input: FetchInput = {}): ZenFetch {
  const upstream = input.upstream ?? globalThis.fetch
  const uuid = input.uuid ?? randomUUID

  return async (requestInput, init) => {
    const request = requestInput instanceof Request ? requestInput : undefined
    const url =
      requestInput instanceof Request
        ? requestInput.url
        : typeof requestInput === "string"
          ? requestInput
          : requestInput.href
    const method = init?.method ?? request?.method
    const options = requestOptions(request, init)
    const signal = init?.signal ?? options.signal
    // Fetch replaces the whole header list when init supplies one, so the
    // Request's headers only apply when init has none. Merging them would keep
    // a header the caller deliberately dropped, e.g. an Authorization key.
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.set("user-agent", ZEN_USER_AGENT)
    headers.set("x-opencode-client", headers.get("x-opencode-client") ?? "cli")
    headers.set("x-opencode-project", headers.get("x-opencode-project") ?? "global")
    // Zen rejects a request without a session header, but callers that carry no
    // conversation id (direct SDK calls) have no thread to keep, so each such
    // request gets its own session instead of sharing one client-wide id. The
    // session runtime always sends the conversation's id (see
    // `session/llm/request.ts`), which is what keeps a conversation stable.
    headers.set("x-opencode-session", sessionID(headers.get("x-opencode-session") ?? undefined, uuid))
    headers.set("x-opencode-request", headers.get("x-opencode-request") ?? requestID(uuid))

    const body = await bodyText(requestInput, init)
    const payload = chatRequest(url, headers, body)
    // Anything that is not a chat completion keeps the caller's method, body,
    // signal, and Request options.
    if (!payload) return upstream(requestInput, { ...options, headers })

    if (typeof payload["model"] === "string" && input.free?.has(payload["model"])) {
      headers.set("authorization", ZEN_PUBLIC_AUTHENTICATION)
    }
    // Zen only answers streamed requests; non-streaming callers get the
    // aggregated stream back below.
    const streaming = payload["stream"] === true
    payload["stream"] = true
    if (!Array.isArray(payload["tools"]) || payload["tools"].length === 0) {
      payload["tools"] = [ZEN_PLACEHOLDER_TOOL]
      // The placeholder cannot satisfy a named or required tool choice.
      if (payload["tool_choice"] !== "auto" && payload["tool_choice"] !== "none") payload["tool_choice"] = "auto"
    }

    // The rewritten body is a different length than whatever the caller
    // computed, so a forwarded Content-Length would be stale.
    headers.delete("content-length")
    const response = await upstream(url, {
      ...options,
      signal,
      method: method ?? "POST",
      headers,
      body: JSON.stringify(payload),
    })
    if (!streaming && response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
      return aggregate(response, { signal, chunkTimeout: input.chunkTimeout })
    }
    return response
  }
}

export * as OpenCodeZen from "./opencode-zen"
