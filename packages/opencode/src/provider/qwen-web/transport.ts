/**
 * Browser-context transport for Qwen Web requests.
 *
 * All requests execute as `fetch` inside the authenticated Chromium page, so
 * cookies, TLS fingerprint and WAF posture are the real browser's. The Node
 * side never reconstructs the cookie jar.
 *
 * - `requestJson` runs a one-shot fetch and returns the complete body.
 * - `requestStream` relays an upstream `ReadableStream` incrementally through
 *   an `exposeBinding` bridge multiplexed by request id, so several streams
 *   can share one page without serializing whole generations.
 */
import { QWEN_WEB_DEFAULTS, QWEN_WEB_ENV, QWEN_WEB_STREAM_ABORTERS_KEY, QWEN_WEB_STREAM_BINDING } from "./constants"
import { QwenWebError, abortedError, classifyTransportFailure, isAbortLike } from "./errors"
import { debug } from "./log"
import { pageRequestHeaders, qwenWebUrl } from "./protocol"
import { QwenWebBrowser, type QwenWebPage, sharedBrowser } from "./browser"

export interface QwenWebTransportOptions {
  browser?: QwenWebBrowser
  metadataTimeoutMs?: number
  idleTimeoutMs?: number
  reasoningIdleTimeoutMs?: number
  maxStreams?: number
  /** Chunk batching inside the page (first chunk always flushes immediately). */
  flushBytes?: number
  flushMs?: number
}

export interface RequestOptions {
  headers?: Record<string, string>
  body?: string
  referrer?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface JsonResponse {
  status: number
  statusText: string
  contentType: string
  body: string
}

export interface StreamResponse {
  status: number
  contentType: string
  stream: ReadableStream<Uint8Array>
  /** Abort the upstream fetch and release the slot. */
  abort: () => void
}

type BridgeEvent =
  | { type: "headers"; status: number; contentType: string }
  | { type: "chunk"; data: string }
  | { type: "done" }
  | { type: "error"; message: string; errorName?: string }

interface StreamState {
  chunks: Uint8Array[]
  done: boolean
  error: Error | undefined
  metadata: { status: number; contentType: string } | undefined
  waiters: Set<() => void>
}

interface BridgeScriptArgs {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  referrer?: string
  requestId: string
  bindingName: string
  abortersKey: string
  flushBytes: number
  flushMs: number
  timeoutMs: number
}

const CLOSED_PATTERNS = [
  "target closed",
  "context was destroyed",
  "execution context was destroyed",
  "page is closed",
  "browser has been closed",
  "connection closed",
  "crash",
]

function isContextLostError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return CLOSED_PATTERNS.some((pattern) => message.includes(pattern))
}

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly capacity: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedError()
    if (this.active < this.capacity) {
      this.active++
      return this.release.bind(this, { released: false })
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(grant)
        if (index !== -1) this.queue.splice(index, 1)
        signal?.removeEventListener("abort", onAbort)
        reject(abortedError())
      }
      const grant = () => {
        signal?.removeEventListener("abort", onAbort)
        this.active++
        resolve(this.release.bind(this, { released: false }))
      }
      this.queue.push(grant)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private release(token: { released: boolean }): void {
    if (token.released) return
    token.released = true
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export class QwenWebTransport {
  private readonly browser: QwenWebBrowser
  private readonly metadataTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly reasoningIdleTimeoutMs: number
  private readonly slots: Semaphore
  private readonly flushBytes: number
  private readonly flushMs: number
  private readonly states = new Map<string, StreamState>()
  private readonly boundPages = new WeakSet<QwenWebPage>()
  private readonly bindingInFlight = new WeakMap<QwenWebPage, Promise<void>>()
  private readonly encoder = new TextEncoder()
  private requestCounter = 0

  constructor(options?: QwenWebTransportOptions) {
    this.browser = options?.browser ?? sharedBrowser()
    this.metadataTimeoutMs =
      options?.metadataTimeoutMs ?? readNumber(QWEN_WEB_ENV.metadataTimeoutMs, QWEN_WEB_DEFAULTS.metadataTimeoutMs)
    this.idleTimeoutMs =
      options?.idleTimeoutMs ?? readNumber(QWEN_WEB_ENV.idleTimeoutMs, QWEN_WEB_DEFAULTS.idleTimeoutMs)
    this.reasoningIdleTimeoutMs = options?.reasoningIdleTimeoutMs ?? QWEN_WEB_DEFAULTS.reasoningIdleTimeoutMs
    this.slots = new Semaphore(options?.maxStreams ?? readNumber(QWEN_WEB_ENV.maxStreams, QWEN_WEB_DEFAULTS.maxStreams))
    this.flushBytes = options?.flushBytes ?? 512
    this.flushMs = options?.flushMs ?? 8
  }

  idleBudgetMs(reasoning: boolean): number {
    return reasoning ? this.reasoningIdleTimeoutMs : this.idleTimeoutMs
  }

  /** One-shot JSON/text request executed inside the page. */
  async requestJson(method: string, path: string, options?: RequestOptions): Promise<JsonResponse> {
    const signal = options?.signal
    if (signal?.aborted) throw abortedError()
    const url = qwenWebUrl(path)
    const headers = { ...pageRequestHeaders(), ...options?.headers }
    const timeoutMs = options?.timeoutMs ?? this.metadataTimeoutMs
    const body = options?.body
    const referrer = options?.referrer
    try {
      const page = await this.browser.ensureOnOrigin(signal)
      return await page.evaluate(
        async (arg: {
          url: string
          method: string
          headers: Record<string, string>
          body?: string
          referrer?: string
          timeoutMs: number
        }) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), arg.timeoutMs)
          try {
            const response = await fetch(arg.url, {
              method: arg.method,
              credentials: "include",
              headers: arg.headers,
              body: arg.body,
              signal: controller.signal,
              ...(arg.referrer ? { referrer: arg.referrer } : {}),
            })
            const text = await response.text().catch(() => "")
            return {
              status: response.status,
              statusText: response.statusText,
              contentType: response.headers.get("content-type") ?? "",
              body: text,
            }
          } finally {
            clearTimeout(timer)
          }
        },
        { url, method, headers, body, referrer, timeoutMs },
      )
    } catch (error) {
      throw this.translatePageError(error, signal)
    }
  }

  /** Streaming request relayed incrementally through the binding bridge. */
  async requestStream(
    method: string,
    path: string,
    options?: RequestOptions & { reasoning?: boolean },
  ): Promise<StreamResponse> {
    const signal = options?.signal
    if (signal?.aborted) throw abortedError()
    const releaseSlot = await this.slots.acquire(signal)
    try {
      const page = await this.browser.ensureOnOrigin(signal)
      await this.ensureBinding(page)
      return await this.startStream(page, method, path, options, releaseSlot)
    } catch (error) {
      releaseSlot()
      throw this.translatePageError(error, signal)
    }
  }

  private async startStream(
    page: QwenWebPage,
    method: string,
    path: string,
    options: (RequestOptions & { reasoning?: boolean }) | undefined,
    releaseSlot: () => void,
  ): Promise<StreamResponse> {
    const signal = options?.signal
    const requestId = `qw-${Date.now().toString(36)}-${++this.requestCounter}-${Math.random().toString(36).slice(2)}`
    const state: StreamState = { chunks: [], done: false, error: undefined, metadata: undefined, waiters: new Set() }
    this.states.set(requestId, state)

    let released = false
    const release = () => {
      if (released) return
      released = true
      this.states.delete(requestId)
      for (const waiter of state.waiters) waiter()
      state.waiters.clear()
      releaseSlot()
    }

    const abort = () => {
      // Fire-and-forget: the page may already be gone; rejection is swallowed.
      void page
        .evaluate(
          (arg: { abortersKey: string; requestId: string }) => {
            const registry = (globalThis as unknown as Record<string, unknown>)[arg.abortersKey] as
              | Map<string, AbortController>
              | undefined
            registry?.get(arg.requestId)?.abort()
            return true
          },
          { abortersKey: QWEN_WEB_STREAM_ABORTERS_KEY, requestId },
        )
        .catch(() => false)
      state.error = state.error ?? abortedError()
      state.done = true
      release()
    }

    const onAbort = () => abort()
    signal?.addEventListener("abort", onAbort, { once: true })

    const url = qwenWebUrl(path)
    const headers = { ...pageRequestHeaders(), ...options?.headers }
    const scriptArgs: BridgeScriptArgs = {
      url,
      method,
      headers,
      body: options?.body,
      referrer: options?.referrer,
      requestId,
      bindingName: QWEN_WEB_STREAM_BINDING,
      abortersKey: QWEN_WEB_STREAM_ABORTERS_KEY,
      flushBytes: this.flushBytes,
      flushMs: this.flushMs,
      timeoutMs: this.metadataTimeoutMs,
    }

    try {
      await page.evaluate(runBridgeFetch, scriptArgs)
    } catch (error) {
      signal?.removeEventListener("abort", onAbort)
      release()
      throw error
    }

    const metadata = await this.waitForMetadata(requestId, state, signal).catch((error) => {
      signal?.removeEventListener("abort", onAbort)
      abort()
      throw error
    })
    signal?.removeEventListener("abort", onAbort)
    if (signal) signal.addEventListener("abort", onAbort, { once: true })

    const idleMs = this.idleBudgetMs(options?.reasoning ?? false)
    const stream = this.assembleStream(requestId, state, idleMs, signal, () => {
      signal?.removeEventListener("abort", onAbort)
      abort()
      release()
    })
    return {
      status: metadata.status,
      contentType: metadata.contentType,
      stream,
      abort: () => {
        signal?.removeEventListener("abort", onAbort)
        abort()
      },
    }
  }

  private assembleStream(
    requestId: string,
    state: StreamState,
    idleMs: number,
    signal: AbortSignal | undefined,
    cleanup: () => void,
  ): ReadableStream<Uint8Array> {
    let finished = false
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>, error?: Error) => {
      if (finished) return
      finished = true
      cleanup()
      if (error) controller.error(error)
      else controller.close()
    }
    const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      for (;;) {
        if (signal?.aborted) {
          finish(controller, abortedError())
          return
        }
        if (state.chunks.length > 0) {
          controller.enqueue(state.chunks.shift()!)
          return
        }
        if (state.done) {
          finish(controller, state.error)
          return
        }
        const arrived = await this.waitForChunk(state, idleMs).catch((error) => error as Error)
        if (arrived instanceof Error) {
          finish(controller, arrived)
          return
        }
      }
    }
    return new ReadableStream<Uint8Array>({
      pull: (controller) => pump(controller),
      cancel: () => {
        finishSlots(this.states.get(requestId))
        cleanup()
      },
    })
  }

  private waitForChunk(state: StreamState, idleMs: number): Promise<void> {
    if (state.chunks.length > 0 || state.done) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiters.delete(wake)
        reject(
          new QwenWebError({
            code: "timeout",
            retryable: true,
            message: `Qwen stream stalled: no data for ${idleMs}ms.`,
          }),
        )
      }, idleMs)
      timer.unref?.()
      const wake = () => {
        clearTimeout(timer)
        state.waiters.delete(wake)
        resolve()
      }
      state.waiters.add(wake)
      if (state.chunks.length > 0 || state.done) wake()
    })
  }

  private waitForMetadata(
    requestId: string,
    state: StreamState,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; contentType: string }> {
    if (state.metadata) return Promise.resolve(state.metadata)
    if (state.error) return Promise.reject(state.error)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new QwenWebError({
            code: "timeout",
            retryable: true,
            message: `Qwen stream timed out waiting for response headers after ${this.metadataTimeoutMs}ms.`,
          }),
        )
      }, this.metadataTimeoutMs)
      timer.unref?.()
      const onAbort = () => {
        cleanup()
        reject(abortedError())
      }
      const wake = () => {
        if (state.metadata) {
          cleanup()
          resolve(state.metadata)
          return
        }
        if (state.error || state.done) {
          cleanup()
          reject(
            state.error ??
              new QwenWebError({
                code: "upstream_error",
                retryable: true,
                message: "Qwen stream ended before response headers arrived.",
              }),
          )
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        state.waiters.delete(wake)
        signal?.removeEventListener("abort", onAbort)
      }
      state.waiters.add(wake)
      signal?.addEventListener("abort", onAbort, { once: true })
      wake()
      void requestId
    })
  }

  private async ensureBinding(page: QwenWebPage): Promise<void> {
    if (this.boundPages.has(page)) return
    const inFlight = this.bindingInFlight.get(page)
    if (inFlight) return inFlight
    const install = page
      .exposeBinding(QWEN_WEB_STREAM_BINDING, (_source: unknown, requestId: string, event: BridgeEvent) => {
        this.onBridgeEvent(requestId, event)
      })
      .then(() => {
        this.boundPages.add(page)
        this.bindingInFlight.delete(page)
      })
      .catch((error) => {
        this.bindingInFlight.delete(page)
        // Re-installing on an already-bound page (e.g. after recreation with
        // the same object) is harmless.
        if (error instanceof Error && /already exists|registered/i.test(error.message)) {
          this.boundPages.add(page)
          return
        }
        throw error
      })
    this.bindingInFlight.set(page, install)
    return install
  }

  private onBridgeEvent(requestId: string, event: BridgeEvent): void {
    const state = this.states.get(requestId)
    if (!state) return
    switch (event.type) {
      case "headers":
        state.metadata = { status: event.status, contentType: event.contentType }
        break
      case "chunk":
        if (event.data) state.chunks.push(this.encoder.encode(event.data))
        break
      case "done":
        state.done = true
        break
      case "error": {
        const error =
          event.errorName === "AbortError"
            ? abortedError()
            : new QwenWebError({
                code: "network_error",
                retryable: true,
                message: `Qwen stream failed in the browser: ${event.message.slice(0, 300)}`,
              })
        state.error = error
        state.done = true
        break
      }
    }
    for (const waiter of state.waiters) waiter()
    state.waiters.clear()
  }

  private translatePageError(error: unknown, signal?: AbortSignal): QwenWebError {
    if (QwenWebError.isInstance(error)) {
      if (error.code === "aborted") return error
      if (isContextLostError(error)) this.browser.invalidatePage()
      return error
    }
    if (isAbortLike(error) || signal?.aborted) return abortedError()
    if (isContextLostError(error)) {
      this.browser.invalidatePage()
      debug("transport", "page/context lost; invalidated for recreation")
      return new QwenWebError({
        code: "browser_error",
        retryable: true,
        cause: error,
        message: "The Qwen browser page was closed or crashed. Retrying will recreate it.",
      })
    }
    return classifyTransportFailure(error)
  }
}

/**
 * Runs inside the page: performs the fetch with the browser session and
 * relays the response incrementally through the exposed binding. Returns
 * immediately so the Node side is never blocked on a whole generation.
 */
async function runBridgeFetch(arg: BridgeScriptArgs): Promise<boolean> {
  const registry = globalThis as unknown as Record<string, unknown>
  const notify = registry[arg.bindingName] as ((requestId: string, event: BridgeEvent) => Promise<void>) | undefined
  if (typeof notify !== "function") throw new Error("Qwen stream binding is unavailable")

  let aborters = registry[arg.abortersKey] as Map<string, AbortController> | undefined
  if (!aborters) {
    aborters = new Map<string, AbortController>()
    registry[arg.abortersKey] = aborters
  }
  const controller = new AbortController()
  aborters.set(arg.requestId, controller)
  const timeout = setTimeout(() => controller.abort(), arg.timeoutMs)

  void (async () => {
    try {
      const response = await fetch(arg.url, {
        method: arg.method,
        credentials: "include",
        headers: arg.headers,
        body: arg.body,
        signal: controller.signal,
        ...(arg.referrer ? { referrer: arg.referrer } : {}),
      })
      clearTimeout(timeout)
      await notify(arg.requestId, {
        type: "headers",
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
      })
      if (!response.body) {
        await notify(arg.requestId, { type: "done" })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      let lastFlush = Date.now()
      let firstSent = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        buffered += decoder.decode(value, { stream: true })
        if (!firstSent || buffered.length >= arg.flushBytes || Date.now() - lastFlush >= arg.flushMs) {
          const data = buffered
          buffered = ""
          firstSent = true
          lastFlush = Date.now()
          await notify(arg.requestId, { type: "chunk", data })
        }
      }
      buffered += decoder.decode()
      if (buffered) await notify(arg.requestId, { type: "chunk", data: buffered })
      await notify(arg.requestId, { type: "done" })
    } catch (error) {
      clearTimeout(timeout)
      try {
        await notify(arg.requestId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
        })
      } catch {
        // Node already went away; nothing to report to.
      }
    } finally {
      aborters?.delete(arg.requestId)
    }
  })()

  return true
}

function finishSlots(state: StreamState | undefined): void {
  if (!state) return
  state.done = true
  for (const waiter of state.waiters) waiter()
  state.waiters.clear()
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Process-wide shared transport. Tests construct `QwenWebTransport` directly. */
let shared: QwenWebTransport | undefined

export function sharedTransport(): QwenWebTransport {
  if (!shared) shared = new QwenWebTransport()
  return shared
}

/** Test seam: replace or clear the shared instance. */
export function setSharedTransport(transport: QwenWebTransport | undefined): void {
  shared = transport
}
