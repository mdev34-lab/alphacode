import { describe, expect, test } from "bun:test"
import type { QwenWebBrowser, QwenWebPage } from "@/provider/qwen-web/browser"
import { QwenWebError } from "@/provider/qwen-web/errors"
import { QwenWebTransport, type JsonResponse } from "@/provider/qwen-web/transport"

interface BridgeCall {
  requestId: string
  bindingName: string
}

interface Fake {
  page: QwenWebPage
  bindings: Map<string, (...args: any[]) => unknown>
  evaluates: Array<{ kind: "json" | "bridge" | "abort"; arg: Record<string, any> }>
  jsonHandler: (arg: Record<string, any>) => JsonResponse
  onBridge: (call: BridgeCall) => void
  ensureOnOrigin: () => Promise<QwenWebPage>
  invalidated: () => boolean
  browser: QwenWebBrowser
}

function makeFake(): Fake {
  const fake = {} as Fake
  fake.bindings = new Map()
  fake.evaluates = []
  fake.jsonHandler = () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" })
  fake.onBridge = () => {}
  fake.page = {
    url: () => "https://chat.qwen.ai/",
    isClosed: () => false,
    goto: async () => {},
    evaluate: (async (_fn: unknown, arg: Record<string, any>) => {
      if (arg?.bindingName) {
        fake.evaluates.push({ kind: "bridge", arg })
        const call = { requestId: arg.requestId as string, bindingName: arg.bindingName as string }
        setTimeout(() => fake.onBridge(call), 0)
        return true
      }
      if (arg?.abortersKey) {
        fake.evaluates.push({ kind: "abort", arg })
        return true
      }
      fake.evaluates.push({ kind: "json", arg })
      return fake.jsonHandler(arg)
    }) as QwenWebPage["evaluate"],
    exposeBinding: (async (name: string, callback: (...args: any[]) => unknown) => {
      fake.bindings.set(name, callback)
    }) as QwenWebPage["exposeBinding"],
    title: async () => "",
    context: () => ({}) as QwenWebPage["context"] extends () => infer C ? C : never,
    on: () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  } as unknown as QwenWebPage
  let invalidated = false
  fake.invalidated = () => invalidated
  fake.ensureOnOrigin = async () => fake.page
  fake.browser = {
    ensureOnOrigin: (...args: unknown[]) => (fake.ensureOnOrigin as (...a: unknown[]) => Promise<QwenWebPage>)(...args),
    invalidatePage: () => {
      invalidated = true
    },
  } as unknown as QwenWebBrowser
  return fake
}

function emit(fake: Fake, call: BridgeCall, event: Record<string, unknown>): void {
  const binding = fake.bindings.get(call.bindingName)
  if (!binding) throw new Error(`binding ${call.bindingName} not installed`)
  binding({} as unknown, call.requestId, event)
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function captureRejection(promise: Promise<unknown>): Promise<QwenWebError> {
  try {
    await promise
  } catch (error) {
    return error as QwenWebError
  }
  throw new Error("expected promise to reject")
}

describe("QwenWebTransport.requestJson", () => {
  test("runs in-page fetch with merged headers", async () => {
    const fake = makeFake()
    fake.jsonHandler = (arg) => {
      expect(arg["url"]).toBe("https://chat.qwen.ai/api/models")
      expect(arg["method"]).toBe("GET")
      expect(arg["headers"]["source"]).toBe("web")
      expect(arg["headers"]["x-extra"]).toBe("yes")
      return { status: 200, statusText: "OK", contentType: "application/json", body: '{"data":[]}' }
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestJson("GET", "/api/models", { headers: { "x-extra": "yes" } })
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"data":[]}')
    expect(fake.evaluates.filter((item) => item.kind === "json")).toHaveLength(1)
  })

  test("aborted signals never reach the page", async () => {
    const fake = makeFake()
    const transport = new QwenWebTransport({ browser: fake.browser })
    const controller = new AbortController()
    controller.abort()
    const error = await transport.requestJson("GET", "/x", { signal: controller.signal }).catch((e) => e)
    expect((error as QwenWebError).code).toBe("aborted")
    expect(fake.evaluates).toHaveLength(0)
  })

  test("dead contexts invalidate the page and report retryable errors", async () => {
    const fake = makeFake()
    fake.ensureOnOrigin = async () => {
      throw new Error("Target closed")
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const error = await captureRejection(transport.requestJson("GET", "/x"))
    expect(error.code).toBe("browser_error")
    expect(error.retryable).toBe(true)
    expect(fake.invalidated()).toBe(true)
  })
})

describe("QwenWebTransport.requestStream", () => {
  test("assembles bridged chunks incrementally", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
      emit(fake, call, { type: "chunk", data: "Hello " })
      emit(fake, call, { type: "chunk", data: "world" })
      emit(fake, call, { type: "done" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/api/v2/chat/completions", { body: "{}" })
    expect(response.status).toBe(200)
    // The binding is installed once per page, even across streams.
    expect(fake.bindings.size).toBe(1)
    expect(await readAll(response.stream)).toBe("Hello world")
    // Events for unknown request ids are ignored.
    fake.bindings.get("__alphacodeQwenStream")?.({}, "nope", { type: "chunk", data: "x" })
  })

  test("passes non-200 statuses through to the caller", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 429, contentType: "application/json" })
      emit(fake, call, { type: "chunk", data: '{"success":false}' })
      emit(fake, call, { type: "done" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/x")
    expect(response.status).toBe(429)
    expect(await readAll(response.stream)).toBe('{"success":false}')
  })

  test("bridge errors fail the stream", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
      emit(fake, call, { type: "error", message: "socket hang up" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser })
    const response = await transport.requestStream("POST", "/x")
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("network_error")
    expect(error.retryable).toBe(true)
  })

  test("missing headers time out", async () => {
    const fake = makeFake()
    fake.onBridge = () => {}
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 30 })
    const error = await captureRejection(transport.requestStream("POST", "/x"))
    expect(error.code).toBe("timeout")
    expect(error.retryable).toBe(true)
  })

  test("stalled streams time out on idle", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 30, metadataTimeoutMs: 1000 })
    const response = await transport.requestStream("POST", "/x")
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("timeout")
  })

  test("abort() stops the upstream fetch and releases the slot", async () => {
    const fake = makeFake()
    fake.onBridge = (call) => {
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({ browser: fake.browser, idleTimeoutMs: 5000, metadataTimeoutMs: 1000 })
    const response = await transport.requestStream("POST", "/x")
    response.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.evaluates.some((item) => item.kind === "abort")).toBe(true)
    const error = await captureRejection(readAll(response.stream))
    expect(error.code).toBe("aborted")
  })

  test("external abort signals propagate", async () => {
    const fake = makeFake()
    fake.onBridge = () => {}
    const transport = new QwenWebTransport({ browser: fake.browser, metadataTimeoutMs: 5000 })
    const controller = new AbortController()
    const pending = transport.requestStream("POST", "/x", { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const error = await captureRejection(pending)
    expect(error.code).toBe("aborted")
  })

  test("stream slots serialize beyond capacity", async () => {
    const fake = makeFake()
    const calls: BridgeCall[] = []
    fake.onBridge = (call) => {
      calls.push(call)
      emit(fake, call, { type: "headers", status: 200, contentType: "text/event-stream" })
    }
    const transport = new QwenWebTransport({
      browser: fake.browser,
      maxStreams: 1,
      idleTimeoutMs: 5000,
      metadataTimeoutMs: 1000,
    })
    const first = await transport.requestStream("POST", "/a")
    let second: Awaited<ReturnType<QwenWebTransport["requestStream"]>> | undefined
    const pending = transport.requestStream("POST", "/b").then((response) => {
      second = response
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1)
    expect(second).toBeUndefined()
    first.abort()
    await pending
    expect(calls).toHaveLength(2)
    second?.abort()
  })
})
