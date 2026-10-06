import { afterEach, describe, expect, it } from "bun:test"
import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createTwoFilesPatch } from "diff"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type RepliedEvent = Extract<Event, { type: "permission.replied" }>
type PermissionReplyParams = Parameters<OpencodeClient["permission"]["reply"]>[0]
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
const cleanupDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

/**
 * A real SDK connection over an in-memory stream, so a test can assert on the JSON-RPC ids
 * the SDK actually puts on the wire rather than on a fake that mimics how it allocates them.
 * Nothing is ever written back: requests are left unanswered on purpose.
 */
function realConnection() {
  const sent: Array<Record<string, unknown>> = []
  const decoder = new TextDecoder()
  let buffer = ""
  const incoming = new ReadableStream<Uint8Array>({ start() {} })
  const outgoing = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) sent.push(JSON.parse(line) as Record<string, unknown>)
      }
    },
  })
  // The agent side is never exercised here: only the outgoing direction matters.
  const connection = new AgentSideConnection(() => ({}) as Agent, ndJsonStream(outgoing, incoming))
  return { connection, sent }
}

/**
 * Holds session lookups open, so a `permission.replied` can land in the window where the
 * handler is still setting up for a prompt. `release` opens the oldest held lookup,
 * `openAll` opens every held and future one.
 */
function lookupGate() {
  const held: (() => void)[] = []
  let open = false
  let holds = 0
  return {
    hold: () => {
      holds += 1
      return open ? Promise.resolve() : new Promise<void>((resolve) => held.push(resolve))
    },
    release: () => {
      held.shift()?.()
    },
    openAll: () => {
      open = true
      while (held.length > 0) held.shift()?.()
    },
    /** How many lookups have been held so far, including released ones. */
    holds: () => holds,
  }
}

function createHarness(
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } }),
  options: {
    readonly lookupGate?: ReturnType<typeof lookupGate>
    // Makes the reply call fail, so `process` throws once the editor has answered.
    readonly replyError?: Error
    // Holds the call that posts an answer back to OpenCode open, so the `permission.replied`
    // event that post causes can arrive while it is still in flight.
    readonly replyHold?: Promise<void>
    // Leaves `requestPermission` off the connection, as an editor that does not implement it
    // would: prompts are then rejected back to the server instead of being asked.
    readonly noRequestPermission?: boolean
    // Substitutes a real SDK connection for the fake one below.
    readonly connection?: AgentSideConnection
    // Stands in for the SDK's private transport, which is where the JSON-RPC id of an
    // outgoing request comes from. Left out by default: a SDK that hides those fields must
    // degrade to not cancelling rather than to guessing an id.
    readonly transport?: boolean
  } = {},
) {
  const replies: PermissionReplyParams[] = []
  const requests: RequestPermissionRequest[] = []
  const updates: SessionUpdateParams[] = []
  const cancellations: Array<{ method: string; params: Record<string, unknown> }> = []
  const sessions = makeSessionService()
  const gate = options.lookupGate
  const session: ACPSession.Interface = gate
    ? {
        ...sessions,
        tryGet: (sessionId: string) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => gate.hold())
            return yield* sessions.tryGet(sessionId)
          }),
      }
    : sessions
  // The real SDK allocates the id for an outgoing request from this counter, inside the call.
  const transport = { nextRequestId: 41 }
  const sdk = {
    permission: {
      reply: (params: PermissionReplyParams) => {
        replies.push(params)
        if (options.replyError) return Promise.reject(options.replyError)
        const hold = options.replyHold
        return hold ? hold.then(() => ({ data: true })) : Promise.resolve({ data: true })
      },
    },
    session: {
      message: () => Promise.resolve({ data: undefined }),
    },
  } as unknown as OpencodeClient
  // `satisfies` below keeps the fake honest about the shapes the handler relies on,
  // including the private transport the JSON-RPC id is read from.
  const connection = {
    ...(options.noRequestPermission
      ? {}
      : {
          requestPermission: (params: RequestPermissionRequest) => {
            transport.nextRequestId += 1
            requests.push(params)
            return requestPermission(params)
          },
        }),
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
    extNotification: (method: string, params: Record<string, unknown>) => {
      cancellations.push({ method, params })
      return Promise.resolve()
    },
    ...(options.transport ? { connection: transport } : {}),
  } satisfies Partial<Pick<AgentSideConnection, "requestPermission" | "sessionUpdate" | "extNotification">> & {
    readonly connection?: { nextRequestId: number }
  }
  const subscription = new ACPEvent.Subscription({ sdk, connection: options.connection ?? connection, session })

  return { cancellations, connection, replies, requests, sdk, session, subscription, updates }
}

async function createSession(session: ACPSession.Interface, sessionId: string, cwd = "/workspace") {
  await Effect.runPromise(session.create({ id: sessionId, cwd }))
}

async function createKnownTextPart(
  session: ACPSession.Interface,
  sessionId: string,
  messageId: string,
  partId: string,
) {
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId,
      partId,
      partType: "text",
      role: "assistant",
    }),
  )
}

function permissionAsked(
  sessionID: string,
  id: string,
  input: {
    permission?: string
    metadata?: Record<string, unknown>
    tool?: { messageID: string; callID: string }
  } = {},
) {
  return {
    id: `evt_${id}`,
    type: "permission.asked",
    properties: {
      id,
      sessionID,
      permission: input.permission ?? "bash",
      patterns: ["*"],
      metadata: input.metadata ?? { command: "printf hello" },
      always: [],
      ...(input.tool ? { tool: input.tool } : {}),
    },
  } as PermissionEvent
}

function permissionReplied(sessionID: string, requestID: string, reply: "once" | "always" | "reject" | "timeout") {
  return {
    id: `evt_${requestID}_replied`,
    type: "permission.replied",
    properties: { sessionID, requestID, reply },
  } as RepliedEvent
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string) {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  } as Event
}

function textFromUpdates(updates: SessionUpdateParams[], sessionId: string) {
  return updates
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.update)
    .filter((update): update is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => {
      return update.sessionUpdate === "agent_message_chunk"
    })
    .map((update) => (update.content.type === "text" ? update.content.text : ""))
    .join("")
}

async function tempFile(name: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-acp-permission-"))
  cleanupDirs.push(dir)
  const file = path.join(dir, name)
  await Bun.write(file, content)
  return file
}

describe("acp permissions", () => {
  it("sends requestPermission and replies with the selected outcome", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1", { tool: { messageID: "msg_1", callID: "call_1" } }))

    await pollUntil(() => harness.replies.length === 1, "permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "printf hello",
        rawInput: { command: "printf hello" },
        kind: "execute",
        locations: [],
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    })
    expect(harness.replies).toEqual([{ requestID: "perm_1", reply: "once", directory: "/workspace" }])
  })

  it("uses permission metadata for non-shell titles", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_fetch", {
        permission: "webfetch",
        metadata: {
          url: "https://example.com/docs",
          format: "markdown",
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "webfetch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "https://example.com/docs",
      kind: "fetch",
      rawInput: { url: "https://example.com/docs", format: "markdown" },
    })
  })

  it("includes a diff content block for edit permission metadata", async () => {
    const filepath = await tempFile("file.ts", "before\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_edit", {
        permission: "edit",
        metadata: {
          filepath,
          diff: createTwoFilesPatch(filepath, filepath, "before\n", "after\n"),
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "edit permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: filepath,
      kind: "edit",
      locations: [{ path: filepath }],
      content: [
        {
          type: "diff",
          path: filepath,
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    })
  })

  it("includes per-file diff blocks and locations for apply_patch permission metadata", async () => {
    const first = await tempFile("first.ts", "one\n")
    const second = await tempFile("second.ts", "alpha\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_patch", {
        permission: "edit",
        metadata: {
          filepath: "first.ts, second.ts",
          files: [
            {
              filePath: first,
              relativePath: "first.ts",
              patch: createTwoFilesPatch(first, first, "one\n", "two\n"),
            },
            {
              filePath: second,
              relativePath: "second.ts",
              patch: createTwoFilesPatch(second, second, "alpha\n", "beta\n"),
            },
          ],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "apply_patch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "2 files",
      locations: [{ path: first }, { path: second }],
      content: [
        {
          type: "diff",
          path: first,
          oldText: "one\n",
          newText: "two\n",
        },
        {
          type: "diff",
          path: second,
          oldText: "alpha\n",
          newText: "beta\n",
        },
      ],
    })
  })

  it("forwards external_directory metadata and locations to requestPermission", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_external", {
        permission: "external_directory",
        metadata: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "external_directory permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "Create external directory",
        rawInput: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        locations: [{ path: "/tmp/outside" }],
      },
    })
  })

  it("rejects non-selected outcomes", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_cancelled"))

    await pollUntil(() => harness.replies.length === 1, "cancelled permission was never replied")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_cancelled", reply: "reject" })
  })

  it("rejects when requestPermission fails", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client permission UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_failed"))

    await pollUntil(() => harness.replies.length === 1, "failed permission was never rejected")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_failed", reply: "reject" })
  })

  it("does not let a blocked session A permission block session B message updates", async () => {
    let releasePermission: (() => void) | undefined
    const blocked = new Promise<RequestPermissionResponse>((resolve) => {
      releasePermission = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() => blocked)
    await createSession(harness.session, "ses_a")
    await createSession(harness.session, "ses_b")
    await createKnownTextPart(harness.session, "ses_b", "msg_b", "part_b")

    harness.subscription.handle(permissionAsked("ses_a", "perm_blocked"))
    await pollUntil(() => harness.requests.length === 1, "blocked permission was never requested")

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "session_b_message"))

    expect(textFromUpdates(harness.updates, "ses_b")).toBe("session_b_message")
    expect(harness.replies).toHaveLength(0)

    releasePermission?.()
    await pollUntil(() => harness.replies.length === 1, "blocked permission was never replied after release")
  })

  it("serializes permission requests per session", async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<RequestPermissionResponse>((resolve) => {
      releaseFirst = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() =>
      harness.requests.length === 1 ? first : Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1"))
    harness.subscription.handle(permissionAsked("ses_a", "perm_2"))

    await pollUntil(() => harness.requests.length === 1, "first permission was never requested")
    expect(harness.requests.map((request) => request.toolCall.toolCallId)).toEqual(["perm_1"])

    releaseFirst?.()
    await pollUntil(() => harness.requests.length === 2, "second permission was not requested after first resolved")
    await pollUntil(() => harness.replies.length === 2, "serialized permissions were not both replied")

    expect(harness.replies.map((reply) => [reply.requestID, reply.reply])).toEqual([
      ["perm_1", "once"],
      ["perm_2", "always"],
    ])
  })

  it("releases the session queue when the server settles the prompt itself", async () => {
    const answers: Array<(value: RequestPermissionResponse) => void> = []
    const harness = createHarness(
      () =>
        new Promise<RequestPermissionResponse>((resolve) => {
          answers.push(resolve)
        }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_slow", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    await pollUntil(() => harness.requests.length === 1, "editor was never asked about the first prompt")

    // The countdown expired on the server, which ACP only learns from `permission.replied`.
    harness.subscription.handle(permissionReplied("ses_a", "perm_slow", "timeout"))

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_next", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(
      () => harness.requests.length === 2,
      "the session queue stayed blocked behind the prompt the server had already settled",
    )
    expect(harness.requests[1]).toMatchObject({ toolCall: { toolCallId: "call_2" } })

    // A choice made in the editor after its request expired must not be posted for it.
    answers[0]?.({ outcome: { outcome: "selected", optionId: "once" } })
    answers[1]?.({ outcome: { outcome: "selected", optionId: "always" } })
    await pollUntil(() => harness.replies.length === 1, "the live prompt was never replied")
    expect(harness.replies).toEqual([{ requestID: "perm_next", reply: "always", directory: "/workspace" }])
    // No transport in this harness, so there is no request id to aim a cancel at: the wait
    // is still released, which is what frees OpenCode.
    expect(harness.cancellations).toEqual([])
  })

  it("skips a prompt the server settled while it waited behind another one", async () => {
    const answers: Array<(value: RequestPermissionResponse) => void> = []
    const harness = createHarness(
      () =>
        new Promise<RequestPermissionResponse>((resolve) => {
          answers.push(resolve)
        }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_first", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_second", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.requests.length === 1, "editor was never asked about the first prompt")

    // Both expire while the second is still queued, so it was never sent to the editor and
    // there is nothing to release: it has to be skipped when it reaches the front.
    harness.subscription.handle(permissionReplied("ses_a", "perm_second", "timeout"))
    harness.subscription.handle(permissionReplied("ses_a", "perm_first", "timeout"))

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_third", { tool: { messageID: "msg_1", callID: "call_3" } }),
    )
    await pollUntil(() => harness.requests.length === 2, "the queue never reached the third prompt")
    expect(harness.requests[1]).toMatchObject({ toolCall: { toolCallId: "call_3" } })
    expect(harness.replies).toEqual([])

    answers[1]?.({ outcome: { outcome: "selected", optionId: "once" } })
    await pollUntil(() => harness.replies.length === 1, "the third prompt was never replied")
    expect(harness.replies).toEqual([{ requestID: "perm_third", reply: "once", directory: "/workspace" }])
  })

  it("drops a prompt the server settles during the session lookup", async () => {
    const gate = lookupGate()
    const harness = createHarness(() => new Promise<RequestPermissionResponse>(() => {}), { lookupGate: gate })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_lookup", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    await pollUntil(() => gate.holds() === 1, "the handler never reached the session lookup")
    // Settle it while that lookup is still open, then let the handler resume.
    harness.subscription.handle(permissionReplied("ses_a", "perm_lookup", "timeout"))
    gate.openAll()

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_next", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.requests.length === 1, "the queue never reached the next prompt")
    // The settled prompt never reached the editor: only the next one did, and its answer
    // belongs to the server rather than to the editor.
    expect(harness.requests[0]).toMatchObject({ toolCall: { toolCallId: "call_2" } })
    expect(harness.replies).toEqual([])
    expect(harness.cancellations).toEqual([])
  })

  it("drops a prompt the server settles while the tool call is built", async () => {
    const file = await tempFile("slow.ts", "one\n")
    const patch = createTwoFilesPatch(file, file, "one\n", "two\n")
    // Building an edit prompt reads and patches every file in the metadata before the editor
    // is asked. Enough of them keeps that build open across the single yield below, which is
    // what puts the reply inside the build rather than inside the session lookup.
    const files = Array.from({ length: 4000 }, () => ({ filePath: file, relativePath: "slow.ts", patch }))
    const gate = lookupGate()
    const harness = createHarness(() => new Promise<RequestPermissionResponse>(() => {}), { lookupGate: gate })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_build", {
        permission: "edit",
        metadata: { filepath: "slow.ts", files },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )
    await pollUntil(() => gate.holds() === 1, "the handler never reached the session lookup")
    gate.openAll()
    // Microtask hops only: a timer would wait for the build's file reads to finish, while
    // these let the handler resume past the lookup and suspend inside the build.
    for (let hop = 0; hop < 50; hop++) await Promise.resolve()
    expect(harness.requests).toHaveLength(0)

    harness.subscription.handle(permissionReplied("ses_a", "perm_build", "timeout"))

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_after", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.requests.length === 1, "the queue never reached the next prompt")
    // The settled prompt was never sent, and the queue moved on to the next one.
    expect(harness.requests[0]).toMatchObject({ toolCall: { toolCallId: "call_2" } })
    expect(harness.replies).toEqual([])
  })

  it("does not reply for a prompt the server settled before the editor could be asked", async () => {
    const gate = lookupGate()
    const harness = createHarness(undefined, { lookupGate: gate, noRequestPermission: true })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_noask", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    await pollUntil(() => gate.holds() === 1, "the handler never reached the session lookup")
    harness.subscription.handle(permissionReplied("ses_a", "perm_noask", "timeout"))
    gate.openAll()

    // A prompt nobody can be asked about is rejected back to the server, but not one the
    // server already resolved: that reply would arrive for a request that is gone.
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_live", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.replies.length === 1, "the prompt nobody can answer was never rejected")
    expect(harness.replies).toEqual([{ requestID: "perm_live", reply: "reject", directory: "/workspace" }])
    expect(harness.requests).toEqual([])
  })

  it("cancels the editor dialog when the server settles an open prompt", async () => {
    const harness = createHarness(() => new Promise<RequestPermissionResponse>(() => {}), { transport: true })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_open", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    await pollUntil(() => harness.requests.length === 1, "the editor was never asked")

    harness.subscription.handle(permissionReplied("ses_a", "perm_open", "timeout"))

    await pollUntil(() => harness.cancellations.length === 1, "the editor was never told to close the dialog")
    // 41 is the id the transport hands out for the first request: the handler reads that
    // counter immediately before the call, which is what makes the cancel aim at the open
    // request rather than at the next one.
    expect(harness.cancellations).toEqual([{ method: "$/cancel_request", params: { requestId: 41 } }])
  })

  it("does not cancel a dialog the editor has just answered", async () => {
    let posted: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      posted = resolve
    })
    const harness = createHarness(undefined, { transport: true, replyHold: hold })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_answered", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    // The editor answers at once, and the POST carrying that answer is still in flight when
    // the `permission.replied` event it caused reaches the handler.
    await pollUntil(() => harness.replies.length === 1, "the editor answer was never posted")
    harness.subscription.handle(permissionReplied("ses_a", "perm_answered", "once"))
    // Cancelling is synchronous, so this needs no wait: a dialog the editor completed must
    // not be told to close.
    expect(harness.cancellations).toEqual([])

    posted?.()
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_next", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.requests.length === 2, "the queue never reached the next prompt")
    expect(harness.cancellations).toEqual([])
  })

  it("does not cancel a prompt whose request never reached the editor", async () => {
    let posted: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      posted = resolve
    })
    const harness = createHarness(() => Promise.reject(new Error("editor went away")), {
      transport: true,
      replyHold: hold,
    })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_failed", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    // The request fails, so the handler rejects the prompt back to the server, and the event
    // that post causes arrives while it is still in flight.
    await pollUntil(() => harness.replies.length === 1, "the rejection was never posted")
    harness.subscription.handle(permissionReplied("ses_a", "perm_failed", "reject"))
    expect(harness.cancellations).toEqual([])
    expect(harness.replies).toEqual([{ requestID: "perm_failed", reply: "reject", directory: "/workspace" }])

    posted?.()
  })

  it("cancels by the request id the real SDK puts on the wire", async () => {
    const { connection, sent } = realConnection()
    const harness = createHarness(undefined, { connection })
    await createSession(harness.session, "ses_a")
    // One request ahead of the prompt, so the id under test is not the counter's initial
    // value. Only its id allocation matters, so it is left unanswered.
    void connection.writeTextFile({ sessionId: "ses_a", path: "/workspace/a.ts", content: "a\n" }).catch(() => {})
    const wire = (method: string) => sent.find((message) => message["method"] === method)

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_wire", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    await pollUntil(() => wire("session/request_permission") !== undefined, "the editor was never asked")

    harness.subscription.handle(permissionReplied("ses_a", "perm_wire", "timeout"))

    await pollUntil(() => wire("$/cancel_request") !== undefined, "the editor was never told to close the dialog")
    // Aimed at the request the SDK really sent. The id comes from the connection's private
    // counter, read immediately before the call that allocates from it, so an SDK that moves
    // or hides that counter yields no id, no notification, and a failure here — which is the
    // point: the pinned version is 0.21.0 and this is what says so out loud.
    expect(wire("$/cancel_request")).toMatchObject({
      params: { requestId: wire("session/request_permission")?.["id"] },
    })
    expect(wire("session/request_permission")?.["id"]).toBe(1)
  })

  it("stops tracking a prompt whose handling throws", async () => {
    const harness = createHarness(undefined, { replyError: new Error("reply failed"), transport: true })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_throw", { tool: { messageID: "msg_1", callID: "call_1" } }),
    )
    // The editor answers, posting that answer fails, and handling the prompt throws while it
    // is still marked as waiting on the editor.
    await pollUntil(() => harness.replies.length === 1, "the editor answer was never posted")
    // One macrotask boundary, so the throw has unwound through the handler's cleanup.
    await Bun.sleep(20)

    // The answer did reach the server, which settles the request afterwards. A prompt that
    // were still tracked would be cancelled here, aiming at a dialog the editor already
    // closed when it answered.
    harness.subscription.handle(permissionReplied("ses_a", "perm_throw", "once"))
    await Bun.sleep(20)
    expect(harness.cancellations).toEqual([])

    // And the session queue is not stuck behind the prompt that threw.
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_next", { tool: { messageID: "msg_1", callID: "call_2" } }),
    )
    await pollUntil(() => harness.requests.length === 2, "the queue never reached the next prompt")
  })
})
