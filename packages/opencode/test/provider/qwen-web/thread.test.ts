import { describe, expect, test } from "bun:test"
import { ThreadStore } from "@opencode-ai/webchat/store"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"
import path from "node:path"
import os from "node:os"

const CREATED = (id: string, chatId: string) => `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
const text = (content: string) => `data: {"response_id":"r1","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n`

function byteStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
      controller.close()
    },
  })
}

function endlessStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(CREATED("r1", "c1")))
    },
  })
}

interface Captured {
  payloads: Array<{ path: string; body: Record<string, unknown> }>
  chatCreated: number
  stops: Array<{ chatId: string; responseId?: string }>
}

function fakeTransport(lines: string[], captured: Captured, endless: boolean): QwenWebTransport {
  return {
    requestJson: async (method: string, requestPath: string, options?: { body?: string }) => {
      if (requestPath.includes("/stop")) {
        const body = JSON.parse(options?.body ?? "{}") as { chat_id?: string; response_id?: string }
        captured.stops.push({ chatId: String(body["chat_id"]), responseId: body["response_id"] })
      }
      void method
      return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async (method: string, requestPath: string, options?: { body?: string }) => {
      void method
      void options
      void requestPath
      captured.chatCreated++
      return { status: 200, statusText: "OK", contentType: "application/json", body: '{"chat_id":"c1"}' }
    },
    rawRequestStream: async (method: string, requestPath: string, options?: { body?: string }) => {
      void method
      captured.payloads.push({
        path: requestPath,
        body: JSON.parse(options?.body ?? "{}") as Record<string, unknown>,
      })
      return {
        status: 200,
        contentType: "text/event-stream",
        stream: endless ? endlessStream() : byteStream(lines),
        abort: () => {},
      }
    },
    idleBudgetMs: () => 1000,
  } as unknown as QwenWebTransport
}

function freshStore(): ThreadStore {
  return new ThreadStore({ file: path.join(os.tmpdir(), `qwen-webchat-thread-${Math.random().toString(36).slice(2)}.json`) })
}

function session(lines: string[], captured: Captured, endless = false): QwenWebSession {
  return new QwenWebSession({ transport: fakeTransport(lines, captured, endless), store: freshStore() })
}

describe("QwenWebSession thread engine", () => {
  test("ensureThread returns one persistent thread per model and scope", async () => {
    const sessionInstance = session([], { payloads: [], chatCreated: 0, stops: [] })
    const first = await sessionInstance.ensureThread({ model: "qwen3-max" })
    const second = await sessionInstance.ensureThread({ model: "qwen3-max" })
    expect(second).toBe(first)
    expect(first.id).toBe("qwen-web:qwen3-max")
    expect(await sessionInstance.readThread({ thread: first })).toBe(first)

    const scoped = await sessionInstance.ensureThread({ model: "qwen3-max", scope: "agent-1" })
    expect(scoped.id).toBe("qwen-web:qwen3-max:agent-1")
    expect(scoped).not.toBe(first)
  })

  test("runTurn chains the second turn onto the first response id", async () => {
    const captured: Captured = { payloads: [], chatCreated: 0, stops: [] }
    const lineStream = byteStream([
      CREATED("r1", "c1"),
      text("Hello"),
      'data: {"usage":{"input_tokens":3,"output_tokens":2}}\n',
      "data: [DONE]\n",
    ])
    const sessionInstance = new QwenWebSession({
      transport: {
        ...fakeTransport([], captured, false),
        rawRequestStream: async (method: string, requestPath: string, options?: { body?: string }) => {
          void method
          captured.payloads.push({ path: requestPath, body: JSON.parse(options?.body ?? "{}") as Record<string, unknown> })
          return {
            status: 200,
            contentType: "text/event-stream",
            stream: lineStream,
            abort: () => {},
          }
        },
      } as unknown as QwenWebTransport,
      store: freshStore(),
    })

    const thread = await sessionInstance.ensureThread({ model: "qwen3-max" })
    const events: string[] = []
    for await (const event of sessionInstance.runTurn({ thread, content: "hi" })) {
      events.push(event.type)
    }
    expect(await sessionInstance.readThread({ thread })).toBe(thread)
    expect(thread.messages).toHaveLength(2)
    const assistant = thread.messages[1]
    expect(assistant.providerState).toEqual({ responseId: "r1" })
    expect(events).toContain("response-metadata")
    expect(events).toContain("finish")
    expect((events.at(-1))).toBe("done")

    const second = byteStream([CREATED("r2", "c1"), text("World"), "data: [DONE]\n"])
    ;(sessionInstance as unknown as { transport: QwenWebTransport }).transport = {
      ...fakeTransport([], captured, false),
      rawRequestStream: async (method: string, requestPath: string, options?: { body?: string }) => {
        void method
        captured.payloads.push({
          path: requestPath,
          body: JSON.parse(options?.body ?? "{}") as Record<string, unknown>,
        })
        return { status: 200, contentType: "text/event-stream", stream: second, abort: () => {} }
      },
    } as unknown as QwenWebTransport
    for await (const event of sessionInstance.runTurn({ thread, content: "again" })) {
      void event
    }

    expect(captured.chatCreated).toBe(1)
    expect(captured.payloads).toHaveLength(2)
    expect(captured.payloads[0].path).toContain("chat_id=c1")
    expect(captured.payloads[0].body["parent_id"]).toBeNull()
    expect(captured.payloads[1].path).toContain("chat_id=c1")
    expect(captured.payloads[1].body["parent_id"]).toBe("r1")
    expect((thread.messages.at(-1)?.providerState)).toEqual({ responseId: "r2" })
  })

  test("a parallel turn on the same thread is rejected as busy", async () => {
    const captured: Captured = { payloads: [], chatCreated: 0, stops: [] }
    const sessionInstance = session([], captured, true)
    const thread = await sessionInstance.ensureThread({ model: "qwen3-max" })
    const first = sessionInstance.runTurn({ thread, content: "long" })
    await first.next().catch(() => {})
    const error = await sessionInstance
      .runTurn({ thread, content: "second" })
      .next()
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe("upstream_error")
    await first.return(undefined).catch(() => {})
  })

  test("editMessage rewrites content and marks the node as edited locally", async () => {
    const sessionInstance = session([], { payloads: [], chatCreated: 0, stops: [] })
    const thread = await sessionInstance.ensureThread({ model: "qwen3-max" })
    const events: string[] = []
    for await (const event of sessionInstance.runTurn({ thread, content: "hi" })) {
      events.push(event.type)
    }
    void events
    const userNode = thread.messages[0]
    await sessionInstance.editMessage({ thread, messageId: userNode.id, content: "edited" })
    expect(userNode.content).toBe("edited")
    expect(userNode.providerState).toEqual({ editedLocally: true })
    expect((await sessionInstance.readThread({ thread })).messages[0].parts[0]).toEqual({
      type: "text",
      text: "edited",
    })

    const missing = await sessionInstance
      .editMessage({ thread, messageId: "nope", content: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect((missing as { code?: string }).code).toBe("invalid_response")
  })

  test("forkThread seeds the first turn and clears the seed", async () => {
    const captured: Captured = { payloads: [], chatCreated: 0, stops: [] }
    const forkLines = byteStream([CREATED("r9", "c1"), text("Forked"), "data: [DONE]\n"])
    const sessionInstance = new QwenWebSession({
      transport: {
        ...fakeTransport([], captured, false),
        rawRequestStream: async (method: string, requestPath: string, options?: { body?: string }) => {
          void method
          captured.payloads.push({
            path: requestPath,
            body: JSON.parse(options?.body ?? "{}") as Record<string, unknown>,
          })
          return { status: 200, contentType: "text/event-stream", stream: forkLines, abort: () => {} }
        },
      } as unknown as QwenWebTransport,
      store: freshStore(),
    })
    const parent = await sessionInstance.ensureThread({ model: "qwen3-max" })
    const fork = await sessionInstance.forkThread({ thread: parent, seed: "Remember: blue" })
    expect(fork.seedText).toBe("Remember: blue")
    expect(fork.id).not.toBe(parent.id)

    for await (const event of sessionInstance.runTurn({ thread: fork, content: "hi" })) {
      void event
    }
    expect(fork.seedText).toBeUndefined()
    expect(captured.payloads).toHaveLength(1)
    expect(captured.payloads[0].body["parent_id"]).toBeNull()
    const messages = captured.payloads[0].body["messages"] as Array<{ content: string }>
    const prompt = messages?.[0]?.content ?? ""
    expect(prompt).toContain("Remember: blue")
  })

  test("ThreadStore persists threads to disk and removes them", async () => {
    const file = path.join(os.tmpdir(), `qwen-webchat-store-${Math.random().toString(36).slice(2)}.json`)
    const store = new ThreadStore({ file })
    const thread = { id: "t1", model: "qwen3-max", messages: [], createdAt: 1, updatedAt: 1 }
    expect(store.get("t1")).toBeUndefined()
    store.put(thread)
    expect(store.get("t1")).toBe(thread)
    const reloaded = new ThreadStore({ file })
    expect(reloaded.get("t1")?.id).toBe("t1")
    reloaded.remove("t1")
    expect(new ThreadStore({ file }).get("t1")).toBeUndefined()
  })

  test("deleteThread drops the local thread", async () => {
    const sessionInstance = session([], { payloads: [], chatCreated: 0, stops: [] })
    const thread = await sessionInstance.ensureThread({ model: "qwen3-max" })
    await sessionInstance.deleteThread({ thread })
    expect(await sessionInstance.readThread({ thread })).toBe(thread)
  })
})