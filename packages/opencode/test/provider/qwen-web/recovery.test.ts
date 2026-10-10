/**
 * Issue 232 regression suite: dead upstream chats must recover instead of
 * poisoning the thread, and empty/truncated upstream answers must report
 * honestly. All tests run against scripted fake transports — no browser, no
 * network, no live Qwen traffic.
 */
import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { isStaleChatError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { QwenWebSession } from "@opencode-ai/webchat/adapters/qwen/session"
import { ThreadStore } from "@opencode-ai/webchat/store"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"
import type { WebChatEvent, WebChatThread } from "@opencode-ai/webchat/types"

const DELETED_JSON = JSON.stringify({
  success: false,
  code: "CHAT_NOT_FOUND",
  message: "This chat has been deleted. Please start a new chat to continue.",
})

const CREATED = (id: string, chatId: string) =>
  `data: {"type":"response.created","response":{"id":"${id}","chat_id":"${chatId}"}}\n`
const text = (content: string, responseId = "r1") =>
  `data: {"response_id":"${responseId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n`
const DONE = "data: [DONE]\n"
const STALE_EVENT = `data: {"error":{"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. Please start a new chat to continue."}}\n`

function byteStream(lines: string[], chunkBytes = 64): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.join(""))
  const chunks: Uint8Array[] = []
  for (let index = 0; index < bytes.length; index += chunkBytes) chunks.push(bytes.slice(index, index + chunkBytes))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

type CompletionResult =
  | { kind: "sse"; lines: string[] }
  | { kind: "json"; status: number; body: string; contentType?: string }
  | { kind: "throw"; error: unknown }

interface State {
  payloads: Array<{ path: string; body: Record<string, unknown> }>
  chatsCreated: number
  completionsCalled: number
  stops: string[]
  aborts: number
  newChatIds: string[]
}

function newState(): State {
  return {
    payloads: [],
    chatsCreated: 0,
    completionsCalled: 0,
    stops: [],
    aborts: 0,
    newChatIds: ["fresh-1", "fresh-2", "fresh-3"],
  }
}

function scriptedTransport(results: CompletionResult[], state: State): QwenWebTransport {
  return {
    requestJson: async (_method: string, requestPath: string) => {
      state.stops.push(requestPath)
      return { status: 200, statusText: "OK", contentType: "application/json", body: "{}" }
    },
    requestStream: async () => {
      throw new Error("unexpected requestStream")
    },
    rawRequestJson: async () => {
      state.chatsCreated++
      const id = state.newChatIds[state.chatsCreated - 1] ?? `fresh-${state.chatsCreated}`
      return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ chat_id: id }) }
    },
    rawRequestStream: async (_method: string, requestPath: string, options?: { body?: string }) => {
      state.completionsCalled++
      state.payloads.push({ path: requestPath, body: JSON.parse(options?.body ?? "{}") as Record<string, unknown> })
      const result = results[Math.min(state.completionsCalled - 1, results.length - 1)]!
      if (result.kind === "throw") throw result.error
      if (result.kind === "json") {
        return {
          status: result.status,
          contentType: result.contentType ?? "application/json",
          stream: byteStream([result.body]),
          abort: () => {
            state.aborts++
          },
        }
      }
      return {
        status: 200,
        contentType: "text/event-stream",
        stream: byteStream(result.lines),
        abort: () => {
          state.aborts++
        },
      }
    },
    idleBudgetMs: () => 1000,
  } as unknown as QwenWebTransport
}

function sessionFor(results: CompletionResult[], state: State): QwenWebSession {
  const store = new ThreadStore({
    file: path.join(os.tmpdir(), `qwen-webchat-recovery-${Math.random().toString(36).slice(2)}.json`),
  })
  return new QwenWebSession({ transport: scriptedTransport(results, state), store })
}

/** A thread that already looks like an in-progress conversation. */
async function seededThread(
  session: QwenWebSession,
  options?: { providerId?: string; responseId?: string; seed?: string },
): Promise<WebChatThread> {
  const thread = await session.ensureThread({ model: "qwen3-max" })
  if (options?.providerId) thread.providerId = options.providerId
  if (options?.responseId) {
    thread.messages.push({ id: "u0", role: "user", content: "old", parts: [{ type: "text", text: "old" }] })
    thread.messages.push({
      id: "a0",
      role: "assistant",
      content: "old answer",
      parts: [{ type: "text", text: "old answer" }],
      providerState: { responseId: options.responseId },
    })
  }
  if (options?.seed) thread.seedText = options.seed
  return thread
}

async function drain(gen: AsyncGenerator<WebChatEvent>): Promise<WebChatEvent[]> {
  const events: WebChatEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function promptOf(payload: { body: Record<string, unknown> } | undefined): string {
  const messages = payload?.body["messages"] as Array<{ content?: string }> | undefined
  return messages?.[0]?.content ?? ""
}

describe("fresh-chat recovery from a dead upstream chat (issue 232)", () => {
  test("pre-stream CHAT_NOT_FOUND recovers once, on a fresh chat, with the FULL prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(
      session.runTurn({ thread, content: "trimmed tail", recoveryContent: "FULL PROMPT WITH CONTEXT" }),
    )

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(events.at(-1)?.type).toBe("done")

    // Delivery 1 addressed the dead chat with the trimmed tail.
    expect(state.payloads[0]!.path).toContain("chat_id=dead-chat")
    expect(state.payloads[0]!.body["parent_id"]).toBe("r-old")
    expect(promptOf(state.payloads[0])).toContain("trimmed tail")

    // Delivery 2 rides on a fresh chat: no parent, FULL prompt (never the tail).
    expect(state.chatsCreated).toBe(1)
    expect(state.completionsCalled).toBe(2)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(state.payloads[1]!.body["parent_id"]).toBeNull()
    expect(promptOf(state.payloads[1])).toContain("FULL PROMPT WITH CONTEXT")
    expect(promptOf(state.payloads[1])).not.toContain("trimmed tail")

    // Thread state: fresh binding adopted, dead anchors dropped, the rolled-back
    // delivery left exactly one user node, and the turn committed its anchor.
    expect(thread.providerId).toBe("fresh-1")
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
    expect(thread.messages.some((message) => message.content.includes("trimmed tail"))).toBe(false)
    expect(thread.messages.filter((message) => message.role === "user")).toHaveLength(2) // u0 + recovered turn
    expect(thread.messages.at(-1)?.providerState).toEqual({ responseId: "r9" })
  })

  test("mid-stream CHAT_NOT_FOUND before any output recovers the same way", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [STALE_EVENT] },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL PROMPT" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(promptOf(state.payloads[1])).toBe("FULL PROMPT")
    expect(thread.providerId).toBe("fresh-1")
    // The dead stream was released locally.
    expect(state.aborts).toBe(1)
  })

  test("a dead chat after partial output surfaces honestly and still drops the binding", async () => {
    const state = newState()
    const session = sessionFor(
      [{ kind: "sse", lines: [CREATED("r1", "dead-chat"), text("partial", "r1"), STALE_EVENT] }],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    // The caller saw the partial text, so the turn cannot silently re-run.
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    const errorEvent = events.find((event) => event.type === "error") as { error: unknown } | undefined
    expect(errorEvent).toBeDefined()
    expect(isStaleChatError(errorEvent!.error)).toBe(true)
    expect(events.at(-1)?.type).toBe("done")
    expect(state.completionsCalled).toBe(1) // no hidden second delivery

    // The dead chat is unbound so the NEXT turn starts fresh with a full prompt;
    // the delivered user node stays in the mirror (upstream recorded it).
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
    expect(thread.messages.some((message) => message.role === "user" && message.content === "tail")).toBe(true)
    expect(thread.messages.at(-1)?.role).toBe("user")
  })

  test("recovery is bounded: at most one fresh chat per turn", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "json", status: 200, body: DELETED_JSON }], state)
    const thread = await seededThread(session, { providerId: "dead-chat", responseId: "r-old" })

    const error = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(isStaleChatError(error)).toBe(true)
    // Delivery 1 on the dead chat, then ONE fresh chat whose setup loop is
    // retried once (bounded), then the turn gives up.
    expect(state.chatsCreated).toBe(1)
    expect(state.completionsCalled).toBe(3)
    expect(thread.providerId).toBeUndefined()
    expect(thread.messages.some((message) => message.content.includes("FULL"))).toBe(false)
    expect(thread.messages.some((message) => message.providerState?.["responseId"] === "r-old")).toBe(false)
  })

  test("the recovery re-merges a pending seed into the full prompt", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: DELETED_JSON },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("ok", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat", seed: "Remember: blue" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(promptOf(state.payloads[0])).toContain("Remember: blue")
    expect(promptOf(state.payloads[0])).toContain("tail")
    // The rolled-back delivery restored the seed; the recovery re-merged it
    // with the FULL prompt, not the tail.
    expect(promptOf(state.payloads[1])).toContain("Remember: blue")
    expect(promptOf(state.payloads[1])).toContain("FULL")
    expect(promptOf(state.payloads[1])).not.toContain("tail")
    expect(thread.seedText).toBeUndefined()
  })

  test("pre-stream non-stale failures roll back the user node and restore the seed", async () => {
    const state = newState()
    const session = sessionFor(
      [
        {
          kind: "json",
          status: 401,
          body: JSON.stringify({ success: false, code: "Unauthorized", message: "login please" }),
        },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1", seed: "Remember: blue" })

    const error = await drain(session.runTurn({ thread, content: "tail" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect((error as { code?: string }).code).toBe("session_expired")
    expect(thread.messages).toHaveLength(0)
    expect(thread.seedText).toBe("Remember: blue")
    // The chat itself is alive; only dead chats get unbound.
    expect(thread.providerId).toBe("c1")
  })
})

describe("upstream chat id adoption (issue 232)", () => {
  test("response-created chat_id replaces a divergent local binding", async () => {
    const state = newState()
    const session = sessionFor(
      [
        { kind: "sse", lines: [CREATED("r1", "c2-migrated"), text("hi", "r1"), DONE] },
        { kind: "sse", lines: [CREATED("r2", "c2-migrated"), text("again", "r2"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "c1" })

    await drain(session.runTurn({ thread, content: "first" }))
    expect(thread.providerId).toBe("c2-migrated")

    await drain(session.runTurn({ thread, content: "second" }))
    expect(state.payloads[1]!.path).toContain("chat_id=c2-migrated")
    expect(state.payloads[1]!.body["parent_id"]).toBe("r1")
    expect(state.chatsCreated).toBe(0)
  })
})

describe("honest empty and truncated answers (issue 232)", () => {
  test("an empty turn is an error event, never a false stop", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "sse", lines: [CREATED("r1", "fresh-1"), DONE] }], state)
    const thread = await seededThread(session)

    const events = await drain(session.runTurn({ thread, content: "hi" }))

    expect(events.some((event) => event.type === "finish")).toBe(false)
    const errorEvent = events.find((event) => event.type === "error") as
      | { error: { code?: string; retryable?: boolean; message?: string } }
      | undefined
    expect(errorEvent?.error.code).toBe("invalid_response")
    expect(errorEvent?.error.retryable).toBe(true)
    expect(errorEvent?.error.message).toContain("empty response")
    expect(events.at(-1)?.type).toBe("done")

    // Nothing was committed: no assistant node, but the live chat stays bound
    // and the delivered user node stays in the mirror.
    expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(0)
    expect(thread.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(thread.providerId).toBe("fresh-1")
  })

  test("a reasoning-only turn is not treated as empty", async () => {
    const state = newState()
    const thinking =
      'data: {"response_id":"r1","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["Plan"]},"summary_thought":{"content":["Think first."]}}}}]}\n'
    const session = sessionFor([{ kind: "sse", lines: [CREATED("r1", "fresh-1"), thinking, DONE] }], state)
    const thread = await seededThread(session)

    const events = await drain(session.runTurn({ thread, content: "hi" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(thread.messages.at(-1)?.role).toBe("assistant")
  })

  test("a truncated >8k JSON error body never fabricates a login error", async () => {
    const state = newState()
    const truncatedBody = `{"success":false,"code":"InternalError","message":"upstream exploded: ${"z".repeat(9000)}`
    const session = sessionFor([{ kind: "json", status: 200, body: truncatedBody }], state)
    const thread = await seededThread(session, { providerId: "c1" })

    const error = (await drain(session.runTurn({ thread, content: "hi" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as { code?: string; message?: string; retryable?: boolean }

    expect(error.code).toBe("invalid_response")
    expect(error.message).toContain("truncated")
    expect(error.message).toContain("InternalError")
    expect(error.message?.toLowerCase()).not.toContain("login")
    // The undelivered turn was rolled back.
    expect(thread.messages).toHaveLength(0)
  })

  test("a truncated CHAT_NOT_FOUND body is salvaged and recovers", async () => {
    const state = newState()
    const truncatedStale = `{"success":false,"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. ${"x".repeat(9000)}`
    const session = sessionFor(
      [
        { kind: "json", status: 200, body: truncatedStale },
        { kind: "sse", lines: [CREATED("r9", "fresh-1"), text("Recovered", "r9"), DONE] },
      ],
      state,
    )
    const thread = await seededThread(session, { providerId: "dead-chat" })

    const events = await drain(session.runTurn({ thread, content: "tail", recoveryContent: "FULL" }))

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(state.payloads[1]!.path).toContain("chat_id=fresh-1")
    expect(promptOf(state.payloads[1])).toBe("FULL")
    expect(thread.providerId).toBe("fresh-1")
  })

  test("an empty non-stream body reports itself instead of demanding a login", async () => {
    const state = newState()
    const session = sessionFor([{ kind: "json", status: 200, body: "", contentType: "text/plain" }], state)
    const thread = await seededThread(session, { providerId: "c1" })

    const error = (await drain(session.runTurn({ thread, content: "hi" })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as { code?: string; message?: string }

    expect(error.code).toBe("invalid_response")
    expect(error.message).toContain("<empty body>")
    expect(error.message?.toLowerCase()).not.toContain("login")
  })
})
