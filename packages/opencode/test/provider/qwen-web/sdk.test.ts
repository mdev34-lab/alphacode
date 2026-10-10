import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import {
  APICallError,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { ThreadStore } from "@opencode-ai/webchat/store"
import { createQwenWeb, createQwenWebModel, QwenWebLanguageModel, toApiError } from "@/provider/qwen-web/sdk"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"

function byteStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

/** A byte stream that emits the given SSE lines, then fails the same way a stalled transport does. */
function stalledByteStream(lines: string[], error: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(encoder.encode(lines[index++]!))
        return
      }
      controller.error(error)
    },
  })
}

interface Captured {
  calls: number
  payload?: Record<string, unknown>
  stops: Array<{ chatId: string; responseId: string | undefined }>
  aborted: boolean
}

interface SessionBehavior {
  failFirstWith?: unknown
  failAllWith?: unknown
  stream?: ReadableStream<Uint8Array>
}

function fakeUpload(behavior?: { failWith?: unknown; entries?: unknown[] }) {
  return {
    uploadAll: async () => {
      if (behavior?.failWith) throw behavior.failWith
      return (behavior?.entries ?? []) as never
    },
  }
}

function freshStore(): ThreadStore {
  return new ThreadStore({ file: path.join(os.tmpdir(), `qwen-webchat-sdk-${Math.random().toString(36).slice(2)}.json`) })
}

function model(
  lines: string[],
  captured: Captured,
  options?: {
    sessionBehavior?: SessionBehavior
    uploadBehavior?: { failWith?: unknown; entries?: unknown[] }
  },
): QwenWebLanguageModel {
  const transport: QwenWebTransport = {
    requestJson: async (_method: string, requestPath: string, requestOptions?: { body?: string }) => {
      if (requestPath.includes("/chat/completions/stop")) {
        const body = JSON.parse(requestOptions?.body ?? "{}") as { response_id?: string }
        captured.stops.push({ chatId: "chat-1", responseId: body.response_id })
      }
      return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => ({
      status: 200,
      statusText: "OK",
      contentType: "application/json",
      body: '{"chat_id":"chat-1"}',
    }),
    rawRequestStream: async (_method: string, _requestPath: string, streamOptions?: { body?: string }) => {
      captured.calls++
      if (streamOptions?.body) captured.payload = JSON.parse(streamOptions.body) as Record<string, unknown>
      if (options?.sessionBehavior?.failAllWith) throw options.sessionBehavior.failAllWith
      if (options?.sessionBehavior?.failFirstWith && captured.calls === 1) throw options.sessionBehavior.failFirstWith
      return {
        status: 200,
        contentType: "text/event-stream",
        stream: options?.sessionBehavior?.stream ?? byteStream(lines),
        abort: () => {
          captured.aborted = true
        },
      }
    },
    idleBudgetMs: () => 1000,
  } as unknown as QwenWebTransport
  const session = new QwenWebSession({
    transport,
    store: freshStore(),
  })
  return new QwenWebLanguageModel("qwen3-max", {
    session,
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

const CREATED = 'data: {"type":"response.created","response":{"id":"r1","chat_id":"chat-1"}}\n'
const textEvent = (content: string) =>
  `data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":${JSON.stringify(content)}}}]}\n`

function payloadPrompt(payload: Record<string, unknown> | undefined): string {
  const messages = payload?.["messages"] as Array<{ content?: string }> | undefined
  return messages?.[0]?.content ?? ""
}

function payloadModel(payload: Record<string, unknown> | undefined): string | undefined {
  return payload?.["model"] as string | undefined
}

function payloadReasoning(payload: Record<string, unknown> | undefined): string | undefined {
  const messages = payload?.["messages"] as Array<{ feature_config?: Record<string, unknown> }> | undefined
  const config = messages?.[0]?.feature_config
  if (!config) return undefined
  if (config["thinking_mode"] === "Fast") return "fast"
  if (config["thinking_mode"] === "Thinking") return "thinking"
  if (config["auto_thinking"] === true) return "auto"
  return undefined
}

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
    expect(payloadModel(captured.payload)).toBe("qwen3.8-max")
    expect(payloadPrompt(captured.payload)).toContain("User: hi")
    expect(payloadReasoning(captured.payload)).toBe("auto")
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
    expect(payloadPrompt(captured.payload)).toContain("# TOOLS AVAILABLE")
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

  test("recover a completed tool block on stall instead of erroring", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const block = '<qw_call>\n{"name": "read", "arguments": {"p": 1}}\n</qw_call>'
    const { stream } = await model([], captured, {
      sessionBehavior: { stream: stalledByteStream([CREATED, textEvent(`I'll read.\n${block}`)], stall) },
    }).doStream({
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
  })

  test("recover a pending tool block on stall via parser flush", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const { stream } = await model([], captured, {
      sessionBehavior: {
        stream: stalledByteStream([CREATED, textEvent('<qw_call>\n{"name": "read", "arguments": {"p": 2}}')], stall),
      },
    }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [
        { type: "function", name: "read", inputSchema: { type: "object", properties: { p: { type: "number" } } } },
      ],
    })
    const parts = await collect(stream)
    const toolCall = parts.find((part) => part.type === "tool-call") as unknown as { toolName: string; input: string }
    expect(toolCall.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ p: 2 })
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("tool-calls")
  })

  test("reasoning-only stall finishes gracefully as stop", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const stall = new QwenWebError({ code: "timeout", retryable: true, message: "Qwen stream stalled." })
    const { stream } = await model([], captured, {
      sessionBehavior: {
        stream: stalledByteStream(
          [CREATED, 'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["First."]}}}}]}\n'],
          stall,
        ),
      },
    }).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    const parts = await collect(stream)
    const finish = parts[parts.length - 1] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe("stop")
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
  })

  test("reports unsupported settings as warnings", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
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
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
          toolChoice: { type: "required" },
          responseFormat: { type: "json" },
          stopSequences: ["STOP"],
          providerOptions: { "qwen-web": { reasoningMode: "fast" } },
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("MUST call at least one tool")
    expect(payloadPrompt(captured.payload)).toContain("JSON")
    expect(payloadPrompt(captured.payload)).toContain("STOP")
    expect(payloadReasoning(captured.payload)).toBe("fast")
  })

  test("thinking:false selects fast mode", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], captured).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          providerOptions: { "qwen-web": { thinking: false } },
        })
      ).stream,
    )
    expect(payloadReasoning(captured.payload)).toBe("fast")
  })

  test("retries setup failures once, never auth failures", async () => {
    const retryable: Captured = { calls: 0, stops: [], aborted: false }
    const retryableError = new QwenWebError({ code: "browser_error", message: "crashed", retryable: true })
    await collect(
      (
        await model([CREATED, textEvent("ok"), "data: [DONE]\n"], retryable, {
          sessionBehavior: { failFirstWith: retryableError },
        }).doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        })
      ).stream,
    )
    expect(retryable.calls).toBe(2)

    const fatal: Captured = { calls: 0, stops: [], aborted: false }
    const loginError = new QwenWebError({ code: "login_required", message: "login", retryable: false })
    const fatalModel = await model([CREATED], fatal, { sessionBehavior: { failAllWith: loginError } }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(fatalModel.stream).catch((e) => e)
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
        // Never closes: the consumer cancels instead.
      },
    })
    const languageModel = model([], captured, { sessionBehavior: { stream: endless } })
    const { stream } = await languageModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const reader = stream.getReader()
    expect((await reader.read()).value?.type).toBe("stream-start")
    expect((await reader.read()).value?.type).toBe("response-metadata")
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
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

describe("incremental follow-up turns", () => {
  test("an anchored thread resends only the new user content", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("LONG ORIGINAL CONTEXT")

    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("The follow-up question.")
    expect(follow).not.toContain("LONG ORIGINAL CONTEXT")
  })

  test("lite streams keep the full prompt on anchored threads", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          providerOptions: { "qwen-web": { small: true } },
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("LONG ORIGINAL CONTEXT")
    expect(follow).toContain("The follow-up question.")
  })

  test("the first turn on a fresh thread sends the full prompt", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("Answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Context" }] },
            { role: "assistant", content: [{ type: "text", text: "Previous" }] },
            { role: "user", content: [{ type: "text", text: "Now" }] },
          ],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("Context")
  })

  test("follow-ups with tools resend a short reminder, not the full manifest", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    expect(payloadPrompt(captured.payload)).toContain("# TOOLS AVAILABLE")

    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("The follow-up question.")
    expect(follow).toContain("Tools still available")
    expect(follow).not.toContain("# TOOLS AVAILABLE")
    expect(follow).not.toContain("LONG ORIGINAL CONTEXT")
  })

  test("forced tool choices keep full instructions on follow-ups", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("First answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
          ],
          tools: [
            {
              type: "function",
              name: "read",
              inputSchema: { type: "object", properties: { p: { type: "number" } } },
            },
          ],
          toolChoice: { type: "tool", toolName: "read" },
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("# TOOLS AVAILABLE")
    expect(follow).toContain('MUST call the tool "read"')
  })

  test("tool-loop continuations send only the tool result tail", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const modelInstance = model([CREATED, textEvent("Answer"), "data: [DONE]\n"], captured)
    await collect(
      (
        await modelInstance.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    await collect(
      (
        await modelInstance.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "ORIGINAL CONTEXT" }] },
            { role: "assistant", content: [{ type: "text", text: "I'll call a tool." }] },
            {
              role: "user",
              content: [{ type: "text", text: "Tool Response (read): file contents here" }],
            },
          ],
        })
      ).stream,
    )
    const follow = payloadPrompt(captured.payload)
    expect(follow).toContain("Tool Response (read): file contents here")
    expect(follow).not.toContain("ORIGINAL CONTEXT")
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
describe("issue 232: dead-chat recovery and honest errors at the SDK boundary", () => {
  const DELETED_JSON = JSON.stringify({
    success: false,
    code: "CHAT_NOT_FOUND",
    message: "This chat has been deleted. Please start a new chat to continue.",
  })
  const STALE_EVENT = 'data: {"error":{"code":"CHAT_NOT_FOUND","message":"This chat has been deleted."}}\n'
  const created = (id: string, chatId: string) =>
    `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
  const textFor = (responseId: string, content: string) =>
    `data: {"response_id":"${responseId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n`

  type Scripted = { kind: "sse"; lines: string[] } | { kind: "json"; status: number; body: string }

  function recoveryHarness(completionScript: Scripted[]) {
    const payloads: Array<{ path: string; prompt: string }> = []
    const createdChats: string[] = []
    let completions = 0
    const transport = {
      requestJson: async () => ({ status: 200, statusText: "OK", contentType: "application/json", body: "{}" }),
      requestStream: async () => {
        throw new Error("unexpected requestStream")
      },
      rawRequestJson: async () => {
        const id = `chat-${createdChats.length + 1}`
        createdChats.push(id)
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
      },
      rawRequestStream: async (_method: string, requestPath: string, options?: { body?: string }) => {
        const body = JSON.parse(options?.body ?? "{}") as { messages?: Array<{ content?: string }> }
        payloads.push({ path: requestPath, prompt: body.messages?.[0]?.content ?? "" })
        const result = completionScript[Math.min(completions, completionScript.length - 1)]!
        completions++
        if (result.kind === "json") {
          return { status: result.status, contentType: "application/json", stream: byteStream([result.body]), abort: () => {} }
        }
        return { status: 200, contentType: "text/event-stream", stream: byteStream(result.lines), abort: () => {} }
      },
      idleBudgetMs: () => 1000,
    } as unknown as QwenWebTransport
    const session = new QwenWebSession({ transport, store: freshStore() })
    const languageModel = new QwenWebLanguageModel("qwen3-max", { session, upload: fakeUpload() as never })
    return { languageModel, session, payloads, createdChats }
  }

  const followUpPrompt: LanguageModelV3Prompt = [
    { role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] },
    { role: "assistant", content: [{ type: "text", text: "First answer" }] },
    { role: "user", content: [{ type: "text", text: "The follow-up question." }] },
  ]

  test("a deleted chat recovers once and re-sends the FULL prompt, not the trimmed tail", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "json", status: 200, body: DELETED_JSON },
      { kind: "sse", lines: [created("r2", "chat-2"), textFor("r2", "Second answer"), "data: [DONE]\n"] },
    ])

    // Turn 1 anchors the thread on chat-1.
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    expect(harness.payloads[0]!.prompt).toContain("LONG ORIGINAL CONTEXT")

    // Turn 2's trimmed tail hits CHAT_NOT_FOUND; the caller sees one clean stream.
    const parts = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)

    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    expect(harness.payloads).toHaveLength(3)
    // Attempt 1: the incremental tail against the dead chat.
    expect(harness.payloads[1]!.path).toContain("chat_id=chat-1")
    expect(harness.payloads[1]!.prompt).not.toContain("LONG ORIGINAL CONTEXT")
    // Attempt 2: fresh chat, FULL prompt (the fresh chat has no transcript).
    expect(harness.payloads[2]!.path).toContain("chat_id=chat-2")
    expect(harness.payloads[2]!.prompt).toContain("LONG ORIGINAL CONTEXT")
    expect(harness.payloads[2]!.prompt).toContain("The follow-up question.")
    expect(parts.some((part) => part.type === "text-delta")).toBe(true)
    expect((parts.at(-1) as { finishReason?: { unified?: string } }).finishReason?.unified).toBe("stop")
  })

  test("an anchored thread without a live chat binding keeps the full prompt", async () => {
    const harness = recoveryHarness([{ kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] }])
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )
    // Simulate a poisoned legacy threads.json: anchors survived, binding gone.
    const thread = (harness.session as unknown as { store: ThreadStore }).store.all()[0]!
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r1" })
    thread.providerId = undefined

    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.payloads[1]!.prompt).toContain("LONG ORIGINAL CONTEXT")
    expect(harness.payloads[1]!.prompt).toContain("The follow-up question.")
  })

  test("a mid-stream dead chat after output fails the stream and unbinds the thread", async () => {
    const harness = recoveryHarness([
      { kind: "sse", lines: [CREATED, textEvent("First answer"), "data: [DONE]\n"] },
      { kind: "sse", lines: [created("r2", "chat-1"), textFor("r2", "partial"), STALE_EVENT] },
      { kind: "sse", lines: [created("r3", "chat-2"), textFor("r3", "Recovered"), "data: [DONE]\n"] },
    ])
    await collect(
      (
        await harness.languageModel.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "LONG ORIGINAL CONTEXT" }] }],
        })
      ).stream,
    )

    // Output already reached the caller, so the turn fails honestly instead of re-running.
    const error = await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain("no longer valid")
    expect((error as APICallError).isRetryable).toBe(true)

    // The dead binding was dropped: the next turn starts fresh with the FULL prompt.
    await collect((await harness.languageModel.doStream({ prompt: [...followUpPrompt] })).stream)
    expect(harness.createdChats).toEqual(["chat-1", "chat-2"])
    const last = harness.payloads.at(-1)!
    expect(last.path).toContain("chat_id=chat-2")
    expect(last.prompt).toContain("LONG ORIGINAL CONTEXT")
  })

  test("an empty upstream turn surfaces a retryable API error, not a silent stop", async () => {
    const captured: Captured = { calls: 0, stops: [], aborted: false }
    const { stream } = await model([CREATED, "data: [DONE]\n"], captured).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const error = await collect(stream).catch((e) => e)
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).isRetryable).toBe(true)
    expect((error as APICallError).message).toContain("empty response")
  })
})
