import { describe, expect, test } from "bun:test"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { consumeQwenStream, QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"

function byteStream(lines: string[], chunkBytes = 7): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(lines.join(""))
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkBytes) chunks.push(bytes.slice(i, i + chunkBytes))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function fakeTransport(overrides: Partial<QwenWebTransport> = {}): QwenWebTransport {
  return {
    requestJson: async () => {
      throw new Error("unexpected requestJson")
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => {
      throw new Error("unexpected rawRequestJson")
    },
    rawRequestStream: async () => {
      throw new Error("unexpected rawRequestStream")
    },
    idleBudgetMs: () => 1000,
    ...overrides,
  } as unknown as QwenWebTransport
}

async function captureRejection(promise: Promise<unknown>): Promise<QwenWebError> {
  try {
    await promise
  } catch (error) {
    return error as QwenWebError
  }
  throw new Error("expected promise to reject")
}

describe("QwenWebSession.createChat", () => {
  test("returns the chat id", async () => {
    const calls: string[] = []
    const transport = fakeTransport({
      rawRequestJson: (async (method: string, path: string, options?: { body?: string }) => {
        calls.push(`${method} ${path}`)
        const body = JSON.parse(options?.body ?? "{}")
        expect(body.models).toEqual(["qwen3-max"])
        expect(body.chat_mode).toBe("normal")
        return { status: 200, statusText: "OK", contentType: "application/json", body: '{"data":{"chat_id":"c1"}}' }
      }) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    expect(await session.createChat("qwen3-max")).toBe("c1")
    expect(calls).toEqual(["POST /api/v2/chats/new"])
  })

  test("401 becomes session_expired", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 401,
        statusText: "Unauthorized",
        contentType: "text/plain",
        body: "",
      })) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.createChat("m"))
    expect(error.code).toBe("session_expired")
  })

  test("unexpected payloads become invalid_response", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"data":{}}',
      })) as QwenWebTransport["rawRequestJson"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.createChat("m"))
    expect(error.code).toBe("invalid_response")
  })
})

describe("QwenWebSession.startGeneration", () => {
  test("creates a chat then opens a stream on it", async () => {
    const seen: Array<{ method: string; path: string; body?: string }> = []
    const transport = fakeTransport({
      rawRequestJson: (async (method: string, path: string, options?: { body?: string }) => {
        seen.push({ method, path, body: options?.body })
        return { status: 200, statusText: "OK", contentType: "application/json", body: '{"chat_id":"chat-9"}' }
      }) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async (method: string, path: string, options?: { body?: string }) => {
        seen.push({ method, path, body: options?.body })
        return {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream(["data: [DONE]\n"]),
          abort: () => {},
        }
      }) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const generation = await session.startGeneration({ prompt: "Hi", model: "qwen3-max", reasoningMode: "fast" })
    expect(generation.chatId).toBe("chat-9")
    expect(seen[1]?.path).toBe("/api/v2/chat/completions?chat_id=chat-9")
    const payload = JSON.parse(seen[1]?.body ?? "{}")
    expect(payload.model).toBe("qwen3-max")
    expect(payload.messages[0].content).toBe("Hi")
  })

  test("non-SSE JSON errors are classified", async () => {
    let aborted = false
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async () => ({
        status: 429,
        contentType: "application/json",
        stream: byteStream(['{"success":false,"code":"RateLimited","message":"slow"}']),
        abort: () => {
          aborted = true
        },
      })) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.startGeneration({ prompt: "Hi", model: "m" }))
    expect(error.code).toBe("rate_limited")
    expect(aborted).toBe(true)
  })

  test("HTML responses mean the session is gone", async () => {
    const transport = fakeTransport({
      rawRequestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: '{"chat_id":"c"}',
      })) as QwenWebTransport["rawRequestJson"],
      rawRequestStream: (async () => ({
        status: 200,
        contentType: "text/html",
        stream: byteStream(["<html>login</html>"]),
        abort: () => {},
      })) as QwenWebTransport["rawRequestStream"],
    })
    const session = new QwenWebSession({ transport })
    const error = await captureRejection(session.startGeneration({ prompt: "Hi", model: "m" }))
    expect(error.code).toBe("session_expired")
  })
})

describe("QwenWebSession.stopGeneration", () => {
  test("notifies upstream, then always aborts locally", async () => {
    const calls: string[] = []
    let aborted = false
    const transport = fakeTransport({
      requestJson: (async (method: string, path: string, options?: { body?: string }) => {
        calls.push(`${method} ${path} ${options?.body}`)
        return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
      }) as QwenWebTransport["requestJson"],
    })
    const session = new QwenWebSession({ transport })
    await session.stopGeneration("c1", "r1", () => {
      aborted = true
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("/api/v2/chat/completions/stop?chat_id=c1")
    expect(calls[0]).toContain('"response_id":"r1"')
    expect(aborted).toBe(true)

    await session.stopGeneration("c1", undefined, () => {})
    expect(calls).toHaveLength(1)
  })
})

describe("consumeQwenStream", () => {
  const created = 'data: {"type":"response.created","response":{"id":"r1","chat_id":"c1"}}\n'

  test("diffs cumulative content into ordered deltas", async () => {
    const seen: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        created,
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hello"}}]}\n',
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"Hello world"}}]}\n',
        "data: [DONE]\n",
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual(["Hello", " world"])
    expect(result.text).toBe("Hello world")
    expect(result.responseId).toBe("r1")
    expect(result.chatId).toBe("c1")
    expect(result.finishReason).toBe("stop")
  })

  test("swallows FINISHED and empty deltas", async () => {
    const seen: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"FINISHED"}}]}\n',
        'data: {"choices":[{"delta":{"phase":"answer","status":"finished"}}]}\n',
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual([])
    expect(result.text).toBe("")
    expect(result.finishReason).toBe("stop")
  })

  test("ignores interleaved foreign response ids", async () => {
    const seen: string[] = []
    await consumeQwenStream(
      byteStream([
        'data: {"type":"response.created","response":{"id":"r1"}}\n',
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"mine"}}]}\n',
        'data: {"response_id":"r2","choices":[{"delta":{"phase":"answer","content":"mine + theirs"}}]}\n',
        "data: [DONE]\n",
      ]),
      { onText: (delta) => seen.push(delta) },
    )
    expect(seen).toEqual(["mine"])
  })

  test("captures thinking summaries and usage", async () => {
    const reasoning: string[] = []
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n',
        'data: {"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}\n',
        "data: [DONE]\n",
      ]),
      { onReasoning: (delta) => reasoning.push(delta) },
    )
    expect(reasoning).toEqual(["**Plan**\n\nFirst."])
    expect(result.reasoning).toBe("**Plan**\n\nFirst.")
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  test("stream errors end the consumption with a typed error", async () => {
    const result = await consumeQwenStream(
      byteStream([
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"partial"}}]}\n',
        'data: {"error":{"code":"E1","message":"kaput"}}\n',
      ]),
    )
    expect(result.text).toBe("partial")
    expect(result.finishReason).toBe("error")
    expect(result.error?.code).toBe("upstream_error")
  })

  test("aborted signals stop consumption", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await consumeQwenStream(byteStream(["data: [DONE]\n"]), undefined, controller.signal).catch((e) => e)
    expect(error).toBeInstanceOf(QwenWebError)
    expect((error as QwenWebError).code).toBe("aborted")
  })
})
