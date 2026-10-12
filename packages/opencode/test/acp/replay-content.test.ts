import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Subscription } from "@/acp/event"
import { ACPRequests } from "@/acp/requests"
import type { ACPSession } from "@/acp/session"
import type { Part, SessionMessageResponse } from "@opencode-ai/sdk/v2"

type TextPart = Extract<Part, { type: "text" }>

/**
 * ACP replay policy: internal compaction bookkeeping is stripped, and nothing else is.
 *
 * `Subscription.replayMessage` is the only egress for replayed history. It filters with the shared
 * `isInternalContextPart` predicate that `ShareNext` also uses, so the two external surfaces cannot
 * drift. A `compaction_continue` part is the engine's own resume prompt, and it is a `text` part, so
 * without the predicate it would reach the client as a user message chunk the user never wrote.
 * These tests pin that the filter stays narrow: legitimate `synthetic` content must survive.
 */

const session = { id: "ses_1", cwd: "/repo" } as unknown as ACPSession.Info

function harness() {
  const updates: Array<Record<string, unknown>> = []
  const subscription = new Subscription({
    sdk: {} as never,
    requests: ACPRequests.make(),
    connection: {
      sessionUpdate: (input) => {
        updates.push(input.update as Record<string, unknown>)
        return Promise.resolve()
      },
    },
    session: {
      recordPartMetadata: () => Effect.void,
    } as unknown as ACPSession.Interface,
  })
  return { subscription, updates }
}

function text(id: string, body: string, extra: Record<string, unknown> = {}): TextPart {
  return {
    id,
    sessionID: session.id,
    messageID: "msg_1",
    type: "text",
    text: body,
    ...extra,
  } as unknown as TextPart
}

const COMPACTION_MARKER = text("prt_marker", "compacted context summary", {
  synthetic: true,
  metadata: { compaction_continue: true },
})

const MCP_RESOURCE_TEXT = text("prt_mcp", "server://docs/readme.md contents", { synthetic: true })
const TASK_NOTIFICATION = text("prt_task", "Background task build finished: 3 files changed", { synthetic: true })
const NORMAL = text("prt_normal", "here is the answer")

const COMPACTION_PART = {
  id: "prt_compaction",
  sessionID: session.id,
  messageID: "msg_1",
  type: "compaction",
  auto: true,
} as unknown as Part

const toolResultPart = {
  id: "prt_tool",
  sessionID: session.id,
  messageID: "msg_1",
  type: "tool",
  tool: "read",
  callID: "call_1",
  state: { status: "completed", input: { path: "a.ts" }, output: "file body" },
} as unknown as Part

function message(role: "user" | "assistant", parts: Part[]): SessionMessageResponse {
  return {
    info: { id: "msg_1", sessionID: session.id, role },
    parts,
  } as unknown as SessionMessageResponse
}

const texts = (updates: Array<Record<string, unknown>>) =>
  updates.filter(
    (update) => update["sessionUpdate"] === "agent_message_chunk" || update["sessionUpdate"] === "user_message_chunk",
  )

const payloads = (updates: Array<Record<string, unknown>>) =>
  texts(updates).map((update) => (update["content"] as { text: string }).text)

describe("ACP replay", () => {
  test("strips internal context markers instead of replaying them as user text", async () => {
    const { subscription, updates } = harness()

    await subscription.replayMessage(message("user", [NORMAL, COMPACTION_MARKER]))

    expect(payloads(updates)).toEqual([NORMAL.text])
  })

  test("keeps a tool call and its result paired and intact", async () => {
    const { subscription, updates } = harness()

    await subscription.replayMessage(message("assistant", [NORMAL, toolResultPart, COMPACTION_MARKER]))

    const toolUpdates = updates.filter((update) => String(update["sessionUpdate"]).startsWith("tool_call"))
    // A completed tool replays as a start then a completion; both must survive the marker.
    expect(toolUpdates.map((update) => update["sessionUpdate"])).toEqual(["tool_call", "tool_call_update"])
    expect(toolUpdates.map((update) => (update as { toolCallId: string }).toolCallId)).toEqual(["call_1", "call_1"])
    expect(payloads(updates)).toEqual([NORMAL.text])
  })

  test("never emits a compaction part, which has no ACP representation", async () => {
    const { subscription, updates } = harness()

    await subscription.replayMessage(message("user", [NORMAL, COMPACTION_PART]))

    expect(payloads(updates)).toEqual([NORMAL.text])
  })

  test("preserves legitimate synthetic content: MCP resource reads and background-task notices", async () => {
    const { subscription, updates } = harness()

    await subscription.replayMessage(message("assistant", [MCP_RESOURCE_TEXT, TASK_NOTIFICATION]))

    expect(payloads(updates)).toEqual([MCP_RESOURCE_TEXT.text, TASK_NOTIFICATION.text])
  })
})
