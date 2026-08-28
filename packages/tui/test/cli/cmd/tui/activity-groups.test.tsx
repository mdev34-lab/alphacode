/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ToolPart, UserMessage, GlobalEvent, Part } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import { computeActivityGroups, summarizeActivity } from "../../../../src/util/activity"

const sessionID = "ses_activity"

// Timestamps are epoch milliseconds, like the server emits: the sync store
// orders messages by the stringified created time, so the fixtures must stay
// on one digit width.
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

// Part ids must sort in creation order: the sync store keeps parts ordered by
// id (binary-search insertion) and real part ids are ascending ULIDs.
let partCounter = 0
const nextPartID = () => `prt_${String(++partCounter).padStart(3, "0")}`

const assistant = (id: string, created: number): AssistantMessage => ({
  id,
  sessionID,
  role: "assistant",
  time: { created, completed: created + 1000 },
  parentID: "msg_user",
  modelID: "model",
  providerID: "test",
  mode: "work",
  agent: "work",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const userMessage = (id: string, created: number): UserMessage => ({
  id,
  sessionID,
  role: "user",
  time: { created },
  agent: "work",
  model: { providerID: "test", modelID: "model" },
})

const runningTool = (messageID: string, tool: string, start: number): ToolPart => ({
  id: nextPartID(),
  sessionID,
  messageID,
  type: "tool",
  callID: "call",
  tool,
  state: { status: "running", input: {}, time: { start } },
})

const completedTool = (messageID: string, part: ToolPart, end: number): ToolPart => ({
  ...part,
  state: {
    status: "completed",
    input: {},
    output: "",
    title: "",
    metadata: {},
    time: { start: part.state.status === "pending" ? 0 : part.state.time.start, end },
  },
})

const textPart = (messageID: string, value: string): Part => ({
  id: nextPartID(),
  sessionID,
  messageID,
  type: "text",
  text: value,
})

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function messageEvent(id: string, info: AssistantMessage | UserMessage) {
  return global({ id: `evt_${id}`, type: "message.updated", properties: { sessionID, info } })
}

function partEvent(part: Part) {
  return global({ id: `evt_part_${part.id}`, type: "message.part.updated", properties: { sessionID, time: 0, part } })
}

type SyncData = Awaited<ReturnType<typeof mount>>["sync"]

function rows(sync: SyncData) {
  return (sync.data.message[sessionID] ?? []).map((message) => ({
    message,
    parts: sync.data.part[message.id] ?? [],
  }))
}

function groups(sync: SyncData) {
  return computeActivityGroups(rows(sync))
}

function groupIDs(sync: SyncData): string[] {
  return [...groups(sync).byID.keys()]
}

describe("tui activity grouping over live events", () => {
  test("groups a tool-heavy stretch of the conversation", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(messageEvent("u1", userMessage("msg_u1", at(1))))
      emit(partEvent(textPart("msg_u1", "Investigate the build failure")))

      emit(messageEvent("m1", assistant("msg_m1", at(2))))
      emit(partEvent(textPart("msg_m1", "I will investigate this.")))
      const t1 = runningTool("msg_m1", "bash", 3)
      emit(partEvent(t1))
      emit(messageEvent("m2", assistant("msg_m2", at(4))))
      const t2 = runningTool("msg_m2", "read", 5)
      emit(partEvent(t2))
      const t3 = runningTool("msg_m2", "grep", 6)
      emit(partEvent(t3))

      await wait(() => (sync.data.message[sessionID] ?? []).length === 3)
      await wait(() => groupIDs(sync).length === 1)

      // One group spanning m1 and m2; the user message and the assistant text
      // before the run keep it bounded.
      expect(groupIDs(sync)).toEqual([`act-${t1.id}`])
      const group = groups(sync).byID.get(`act-${t1.id}`)
      expect(group?.items.map((item) => item.part.id)).toEqual([t1.id, t2.id, t3.id])
      expect(group?.items.map((item) => item.message.id)).toEqual(["msg_m1", "msg_m2", "msg_m2"])
      expect(summarizeActivity(group!.items.map((item) => item.part)).working).toBe(true)

      // The agent resumes prose: the run is closed by the text part.
      emit(messageEvent("m3", assistant("msg_m3", at(7))))
      emit(partEvent(textPart("msg_m3", "I found the problem.")))
      await wait(() => (sync.data.message[sessionID] ?? []).length === 4)
      expect(groupIDs(sync)).toEqual([`act-${t1.id}`])

      // Results arrive: the group completes in place.
      emit(partEvent(completedTool("msg_m1", t1, 10)))
      emit(partEvent(completedTool("msg_m2", t2, 11)))
      emit(partEvent(completedTool("msg_m2", t3, 12)))
      await wait(() =>
        (sync.data.part["msg_m1"] ?? []).filter((part): part is ToolPart => part.type === "tool").every((part) => part.state.status === "completed") &&
        (sync.data.part["msg_m2"] ?? []).filter((part): part is ToolPart => part.type === "tool").every((part) => part.state.status === "completed"),
      )
      const done = groups(sync).byID.get(`act-${t1.id}`)
      expect(summarizeActivity(done!.items.map((item) => item.part))).toMatchObject({
        count: 3,
        working: false,
        failed: 0,
        durationMs: 12 - 3,
      })

      // A follow-up stretch after new user input starts a fresh group.
      emit(messageEvent("u2", userMessage("msg_u2", at(13))))
      emit(messageEvent("m4", assistant("msg_m4", at(14))))
      const t4 = runningTool("msg_m4", "bash", 15)
      emit(partEvent(t4))
      await wait(() => (sync.data.message[sessionID] ?? []).length === 6)
      expect(groupIDs(sync)).toEqual([`act-${t1.id}`, `act-${t4.id}`])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the group id stable while a running tool completes and the next one starts", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(messageEvent("m1", assistant("msg_m1", at(1))))
      const t1 = runningTool("msg_m1", "read", 2)
      emit(partEvent(t1))
      await wait(() => groupIDs(sync).length === 1)
      expect(groupIDs(sync)).toEqual([`act-${t1.id}`])

      // t1 completes and t2 starts in a new assistant message: still one group.
      emit(partEvent(completedTool("msg_m1", t1, 3)))
      emit(messageEvent("m2", assistant("msg_m2", at(4))))
      const t2 = runningTool("msg_m2", "bash", 5)
      emit(partEvent(t2))
      await wait(() =>
        (sync.data.part["msg_m1"] ?? []).some((part): part is ToolPart => part.type === "tool" && part.state.status === "completed") &&
        (sync.data.part["msg_m2"] ?? []).some((part) => part.id === t2.id),
      )
      expect(groupIDs(sync)).toEqual([`act-${t1.id}`])

      // A failed tool keeps the group together and is surfaced in the summary.
      emit(messageEvent("m3", assistant("msg_m3", at(6))))
      const t3: ToolPart = {
        id: nextPartID(),
        sessionID,
        messageID: "msg_m3",
        type: "tool",
        callID: "call",
        tool: "bash",
        state: { status: "error", input: {}, error: "command not found", time: { start: 7, end: 8 } },
      }
      emit(partEvent(t3))
      await wait(() => (sync.data.part["msg_m3"] ?? []).length === 1)
      const group = groups(sync).byID.get(`act-${t1.id}`)
      expect(group?.items).toHaveLength(3)
      expect(summarizeActivity(group!.items.map((item) => item.part))).toMatchObject({
        count: 3,
        working: true,
        failed: 1,
      })
    } finally {
      app.renderer.destroy()
    }
  })
})
