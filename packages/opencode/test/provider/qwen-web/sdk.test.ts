import { describe, expect, test } from "bun:test"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { QwenWebError } from "@/provider/qwen-web/errors"
import { createQwenWeb, createQwenWebModel, QwenWebLanguageModel, toApiError } from "@/provider/qwen-web/sdk"
import type { StartGenerationInput } from "@/provider/qwen-web/session"

function byteStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

interface Captured {
  input?: StartGenerationInput
  calls: number
  stops: Array<{ chatId: string; responseId: string | undefined }>
  aborted: boolean
}

function fakeSession(
  lines: string[],
  captured: Captured,
  behavior?: { failFirstWith?: unknown; failAllWith?: unknown },
) {
  return {
    createChat: async () => "chat-1",
    startGeneration: async (input: StartGenerationInput) => {
      captured.calls++
      captured.input = input
      if (behavior?.failAllWith) throw behavior.failAllWith
      if (behavior?.failFirstWith && captured.calls === 1) throw behavior.failFirstWith
      return {
        chatId: "chat-1",
        response: {
          status: 200,
          contentType: "text/event-stream",
          stream: byteStream(lines),
          abort: () => {
            captured.aborted = true
          },
        },
      }
    },
    stopGeneration: async (chatId: string, responseId: string | undefined, abortLocal: () => void) => {
      captured.stops.push({ chatId, responseId })
      abortLocal()
    },
  }
}

function fakeUpload(behavior?: { failWith?: unknown; entries?: Array<{ id: string }> }) {
  return {
    uploadAll: async () => {
      if (behavior?.failWith) throw behavior.failWith
      return (behavior?.entries ?? []) as never
    },
  }
}

function model(
  lines: string[],
  captured: Captured,
  options?: {
    sessionBehavior?: { failFirstWith?: unknown; failAllWith?: unknown }
    uploadBehavior?: { failWith?: unknown; entries?: Array<{ id: string }> }
  },
): QwenWebLanguageModel {
  return new QwenWebLanguageModel("qwen3-max", {
    session: fakeSession(lines, captured, options?.sessionBehavior) as never,
    upload: fakeUpload(options?.uploadBehavior) as never,
  })
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) parts.push(value)
  }
  return parts
}

const CREATED = 'data: {"response.created":{"response_id":"r1","chat_id":"chat-1"}}\n'
const textEvent = (content: string) =>
  `data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":${JSON.stringify(content)}}}]}\n`

describe("QwenWebLanguageModel.doStream", () => {
  test("streams ordered text blocks with linked ids", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [CREATED, textEvent("Hello"), textEvent("Hello world"), "data: [DONE]\n"],
      captured,
    ).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const parts = await collect(stream)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ])
    const start = parts[2] as { id: string }
    expect((parts[3] as { id: string }).id).toBe(start.id)
    expect((parts[3] as { delta: string }).delta).toBe("Hello")
    expect((parts[4] as { delta: string }).delta).toBe(" world")
    const finish = parts[6] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("stop")
    expect(captured.input?.model).toBe("qwen3-max")
    expect(captured.input?.prompt).toContain("User: hi")
    expect(captured.input?.reasoningMode).toBe("auto")
  })

  test("emits tool calls without leaking tags into text", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const block = '<qw_call>\n{"name": "read", "arguments": {"p": 1}}\n</qw_call>'
    const { stream } = await model(
      [CREATED, textEvent("I'll read."), textEvent(`I'll read.\n${block}`), "data: [DONE]\n"],
      captured,
    ).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [
        { type: "function", name: "read", inputSchema: { type: "object", properties: { p: { type: "number" } } } },
      ],
    })
    const parts = await collect(stream)
    const toolCall = parts.find((part) => part.type === "tool-call") as unknown as { toolName: string; input: string }
    expect(toolCall.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ p: 1 })
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("tool-calls")
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("")
    expect(text).toBe("I'll read.\n")
    expect(captured.input?.prompt).toContain("# TOOLS AVAILABLE")
  })

  test("streams reasoning before text", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [
        CREATED,
        'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n',
        textEvent("answer"),
        "data: [DONE]\n",
      ],
      captured,
    ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ])
    expect((parts[3] as { delta: string }).delta).toBe("**Plan**\n\nFirst.")
  })

  test("maps usage and mid-stream errors", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model(
      [CREATED, textEvent("partial"), 'data: {"usage":{"input_tokens":10,"output_tokens":5}}\n', "data: [DONE]\n"],
      captured,
    ).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    const finish = parts[parts.length - 1] as {
      usage: { inputTokens: { total?: number }; outputTokens: { total?: number } }
    }
    expect(finish.usage.inputTokens.total).toBe(10)
    expect(finish.usage.outputTokens.total).toBe(5)

    const failing: Captured = { calls: 0, stops: [], aborted: false }
    const bad = await model([CREATED, 'data: {"error":{"code":"E","message":"kaput"}}\n'], failing).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(bad.stream).catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(true)
  })

  test("reports unsupported settings as warnings", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model([CREATED, "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      temperature: 0.5,
      topP: 0.9,
      tools: [{ type: "provider", name: "search", id: "qwen-web.search" as `${string}.${string}`, args: {} }],
    })
    const parts = await collect(stream)
    const start = parts[0] as { warnings: Array<{ feature?: string }> }
    const features = start.warnings.map((warning) => warning.feature)
    expect(features).toContain("temperature")
    expect(features).toContain("sampling")
    expect(features).toContain("provider tools")
  })

  test("composes prompt overrides and reasoning mode", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    await model([CREATED, "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      toolChoice: { type: "required" },
      responseFormat: { type: "json" },
      stopSequences: ["STOP"],
      providerOptions: { "qwen-web": { reasoningMode: "fast" } },
    })
    expect(captured.input?.prompt).toContain("MUST call at least one tool")
    expect(captured.input?.prompt).toContain("JSON")
    expect(captured.input?.prompt).toContain("STOP")
    expect(captured.input?.reasoningMode).toBe("fast")
  })

  test("thinking:false selects fast mode", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    await model([CREATED, "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { "qwen-web": { thinking: false } },
    })
    expect(captured.input?.reasoningMode).toBe("fast")
  })

  test("retries setup failures once, never auth failures", async () => {
    const retryable: Captured = { calls: 0, stops: [], aborted: false }
    const retryableError = new QwenWebError({ code: "browser_error", message: "crashed", retryable: true })
    await model([CREATED, "data: [DONE]\n"], retryable, {
      sessionBehavior: { failFirstWith: retryableError },
    }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(retryable.calls).toBe(2)

    const fatal: Captured = { calls: 0, stops: [], aborted: false }
    const loginError = new QwenWebError({ code: "login_required", message: "login", retryable: false })
    const error = await model([CREATED], fatal, { sessionBehavior: { failAllWith: loginError } })
      .doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
      .catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(false)
    expect(fatal.calls).toBe(1)
  })

  test("aborted signals reject before setup", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const controller = new AbortController()
    controller.abort()
    const error = await model([CREATED], captured)
      .doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], abortSignal: controller.signal })
      .catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect(captured.calls).toBe(0)
  })

  test("cancel stops the upstream generation with the response id", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(CREATED))
        // Never closes: the test cancels instead.
      },
    })
    const session = {
      createChat: async () => "chat-1",
      startGeneration: async (input: StartGenerationInput) => {
        captured.input = input
        return {
          chatId: "chat-1",
          response: { status: 200, contentType: "text/event-stream", stream: endless, abort: () => {} },
        }
      },
      stopGeneration: async (chatId: string, responseId: string | undefined, abortLocal: () => void) => {
        captured.stops.push({ chatId, responseId })
        abortLocal()
      },
    }
    const languageModel = new QwenWebLanguageModel("m", { session: session as never, upload: fakeUpload() as never })
    const { stream } = await languageModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const reader = stream.getReader()
    expect((await reader.read()).value?.type).toBe("stream-start")
    expect((await reader.read()).value?.type).toBe("response-metadata")
    await reader.cancel()
    expect(captured.stops).toEqual([{ chatId: "chat-1", responseId: "r1" }])
  })

  test("upload failures surface as API errors", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const failure = new QwenWebError({ code: "unsupported", message: "too big", retryable: false })
    const error = await model([CREATED], captured, { uploadBehavior: { failWith: failure } })
      .doStream({
        prompt: [{ role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }] }],
      })
      .catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("too big")
    expect(captured.calls).toBe(0)
  })
})

describe("QwenWebLanguageModel.doGenerate", () => {
  test("collects parts into content", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const result = await model(
      [CREATED, textEvent("Hello"), textEvent("Hello world"), "data: [DONE]\n"],
      captured,
    ).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }])
    expect(result.finishReason.unified).toBe("stop")
    expect(result.warnings).toEqual([])
  })
})

describe("factories and error mapping", () => {
  test("factories build spec-compliant models", () => {
    const languageModel = createQwenWebModel("qwen3-max", { reasoningMode: "thinking" })
    expect(languageModel).toBeInstanceOf(QwenWebLanguageModel)
    expect(languageModel.modelId).toBe("qwen3-max")
    expect(languageModel.provider).toBe("qwen-web")
    expect(languageModel.specificationVersion).toBe("v3")
    expect(createQwenWeb().languageModel("x").modelId).toBe("x")
    expect(languageModel.supportedUrls).toEqual({})
  })

  test("toApiError preserves retryability and status", () => {
    const options: LanguageModelV3CallOptions = { prompt: [] }
    expect(options).toBeDefined()
    const rateLimited = toApiError(
      new QwenWebError({ code: "rate_limited", message: "slow", retryable: true, status: 429 }),
      "m",
    )
    expect(rateLimited).toBeInstanceOf(APICallError)
    expect(rateLimited.isRetryable).toBe(true)
    expect(rateLimited.statusCode).toBe(429)
    const aborted = toApiError(Object.assign(new Error("x"), { name: "AbortError" }), "m")
    expect(aborted.statusCode).toBe(499)
    expect(aborted.isRetryable).toBe(false)
    const unknown = toApiError(new Error("weird"), "m")
    expect(unknown.isRetryable).toBe(true)
    const passthrough = new APICallError({ message: "x", url: "u", requestBodyValues: {}, isRetryable: false })
    expect(toApiError(passthrough, "m")).toBe(passthrough)
  })
})
