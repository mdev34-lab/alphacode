import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import {
  activityHeader,
  computeActivityGroups,
  summarizeActivity,
  toolPartOutcome,
  type ActivityRow,
} from "../../src/util/activity"

const sessionID = "ses_test"

function assistant(id: string, created: number): AssistantMessage {
  return {
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
  }
}

function user(id: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "work",
    model: { providerID: "test", modelID: "model" },
  }
}

function text(messageID: string, id: string, value: string) {
  return { id, sessionID, messageID, type: "text" as const, text: value }
}

function reasoning(messageID: string, id: string, value: string) {
  return {
    id,
    sessionID,
    messageID,
    type: "reasoning" as const,
    text: value,
    time: { start: 0 },
  }
}

function invisible(messageID: string, id: string, type: "step-start" | "step-finish" | "patch") {
  if (type === "step-start") return { id, sessionID, messageID, type: "step-start" as const }
  if (type === "step-finish")
    return {
      id,
      sessionID,
      messageID,
      type: "step-finish" as const,
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  return { id, sessionID, messageID, type: "patch" as const, hash: "abc", files: [] }
}

function tool(
  messageID: string,
  id: string,
  state: ToolPart["state"] = { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
  toolName = "bash",
): ToolPart {
  return { id, sessionID, messageID, type: "tool", callID: `call_${id}`, tool: toolName, state }
}

const running = (start: number): ToolPart["state"] => ({ status: "running", input: {}, time: { start } })
const completed = (start: number, end: number): ToolPart["state"] => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata: {},
  time: { start, end },
})
const failed = (start: number, end: number, error: string): ToolPart["state"] => ({
  status: "error",
  input: {},
  error,
  time: { start, end },
})

describe("toolPartOutcome", () => {
  const part = (state: ToolPart["state"]) => tool("m1", "p1", state)

  test("passes through non-error statuses", () => {
    expect(toolPartOutcome(part({ status: "pending", input: {}, raw: "" }))).toBe("pending")
    expect(toolPartOutcome(part(running(0)))).toBe("running")
    expect(toolPartOutcome(part(completed(0, 1)))).toBe("completed")
  })

  test("classifies user-caused errors as denied", () => {
    expect(toolPartOutcome(part(failed(0, 1, "QuestionRejectedError")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "rejected permission for bash")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "specified a rule that rejects this call")))).toBe("denied")
    expect(toolPartOutcome(part(failed(0, 1, "user dismissed the question")))).toBe("denied")
  })

  test("classifies aborts as interrupted", () => {
    expect(toolPartOutcome(part(failed(0, 1, "Tool execution aborted")))).toBe("interrupted")
    const state: ToolPart["state"] = {
      status: "error",
      input: {},
      error: "Tool execution aborted",
      metadata: { interrupted: true },
      time: { start: 0, end: 1 },
    }
    expect(toolPartOutcome(part(state))).toBe("interrupted")
  })

  test("keeps real failures as errors", () => {
    expect(toolPartOutcome(part(failed(0, 1, "command not found")))).toBe("error")
  })
})

describe("computeActivityGroups", () => {
  test("groups consecutive tool calls in one message", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1"), tool("m1", "t2", completed(0, 2), "read")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.groupOf.get("t1")).toBe("act-t1")
    expect(result.groupOf.get("t2")).toBe("act-t1")
  })

  test("groups a single tool call on its own", () => {
    const rows: ActivityRow[] = [{ message: assistant("m1", 1), parts: [tool("m1", "t1")] }]
    const result = computeActivityGroups(rows)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
  })

  test("merges tool calls across consecutive assistant messages", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)) ] },
      { message: assistant("m2", 2), parts: [tool("m2", "t2", completed(1, 2))] },
      { message: assistant("m3", 3), parts: [tool("m3", "t3", completed(2, 3))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.message.id)).toEqual(["m1", "m2", "m3"])
  })

  test("splits a group at assistant text", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)), text("m1", "x1", "Let me check.")] },
      { message: assistant("m2", 2), parts: [tool("m2", "t2", completed(1, 2)), tool("m2", "t3", completed(1, 3))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2", "t3"])
  })

  test("keeps a group together across reasoning parts", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [tool("m1", "t1", completed(0, 1)), reasoning("m1", "r1", "thinking"), tool("m1", "t2", completed(1, 2))],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(result.byID.get("act-t1")?.parts.map((item) => item.part.id)).toEqual(["t1", "r1", "t2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("t2")).toBe("act-t1")
  })

  test("associates leading and trailing reasoning with the surrounding work run", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [reasoning("m1", "r1", "planning"), tool("m1", "t1", completed(0, 1))],
      },
      {
        message: assistant("m2", 2),
        parts: [tool("m2", "t2", running(1)), reasoning("m2", "r2", "checking the result")],
      },
    ]
    const result = computeActivityGroups(rows)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
    expect(group?.parts.map((item) => item.part.id)).toEqual(["r1", "t1", "t2", "r2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("r2")).toBe("act-t1")
  })

  test("keeps reasoning standalone when no tool run follows it", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [reasoning("m1", "r1", "thinking")] },
      { message: assistant("m2", 2), parts: [text("m2", "x1", "Done.")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.has("r1")).toBe(false)
  })

  test("keeps one group across multiple model turns with CoT interleaved with tool calls", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1))] },
      { message: assistant("m2", 2), parts: [tool("m2", "t2", completed(1, 2))] },
      {
        message: assistant("m3", 3),
        parts: [
          reasoning("m3", "r1", "thinking about the trace"),
          tool("m3", "t3", completed(2, 3)),
          tool("m3", "t4", completed(2, 4)),
        ],
      },
      {
        message: assistant("m4", 4),
        parts: [
          reasoning("m4", "r2", "thinking again"),
          tool("m4", "t5", completed(4, 5)),
          tool("m4", "t6", completed(4, 6)),
        ],
      },
      { message: assistant("m5", 5), parts: [tool("m5", "t7", completed(6, 7))] },
      { message: assistant("m6", 6), parts: [tool("m6", "t8", completed(7, 8), "finish")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    const group = result.byID.get("act-t1")
    expect(group?.items.map((item) => item.part.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"])
    expect(group?.parts.map((item) => item.part.id)).toEqual([
      "t1",
      "t2",
      "r1",
      "t3",
      "t4",
      "r2",
      "t5",
      "t6",
      "t7",
      "t8",
    ])
    expect(result.groupOf.get("r1")).toBe("act-t1")
    expect(result.groupOf.get("r2")).toBe("act-t1")
    expect(result.groupOf.get("t8")).toBe("act-t1")
  })

  test("still splits a group at assistant text when reasoning is present", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          tool("m1", "t1", completed(0, 1)),
          reasoning("m1", "r1", "thinking"),
          text("m1", "x1", "Let me summarize."),
          tool("m1", "t2", completed(1, 2)),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1"])
    expect(result.byID.get("act-t1")?.parts.map((item) => item.part.id)).toEqual(["t1", "r1"])
    expect(result.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2"])
    expect(result.groupOf.get("r1")).toBe("act-t1")
  })

  test("splits a group at user messages", () => {
    const rows: ActivityRow[] = [
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1))] },
      { message: user("u1", 2), parts: [text("u1", "x1", "again")] },
      { message: assistant("m2", 3), parts: [tool("m2", "t2", completed(1, 2))] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(2)
    expect(result.byID.get("act-t1")?.items).toHaveLength(1)
    expect(result.byID.get("act-t2")?.items).toHaveLength(1)
  })

  test("does not split a group at invisible parts", () => {
    const rows: ActivityRow[] = [
      {
        message: assistant("m1", 1),
        parts: [
          invisible("m1", "s1", "step-start"),
          tool("m1", "t1", completed(0, 1)),
          invisible("m1", "s2", "step-finish"),
          invisible("m1", "s3", "step-start"),
          tool("m1", "t2", completed(1, 2)),
          invisible("m1", "s4", "step-finish"),
        ],
      },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(1)
    expect(result.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2"])
  })

  test("keeps the group id stable while the run grows at its tail", () => {
    const t1 = tool("m1", "t1", completed(0, 1))
    const t2 = tool("m2", "t2", completed(1, 2))
    const t3 = tool("m3", "t3", running(2))
    const base = computeActivityGroups([
      { message: assistant("m1", 1), parts: [t1] },
      { message: assistant("m2", 2), parts: [t2] },
    ])
    const grown = computeActivityGroups([
      { message: assistant("m1", 1), parts: [t1] },
      { message: assistant("m2", 2), parts: [t2] },
      { message: assistant("m3", 3), parts: [t3] },
    ])
    expect([...base.byID.keys()]).toEqual(["act-t1"])
    expect([...grown.byID.keys()]).toEqual(["act-t1"])
    expect(grown.byID.get("act-t1")?.items.map((item) => item.part.id)).toEqual(["t1", "t2", "t3"])
  })

  test("re-keys a group when its first part is removed", () => {
    const t2 = tool("m1", "t2", completed(1, 2))
    const t3 = tool("m1", "t3", completed(2, 3))
    const before = computeActivityGroups([
      { message: assistant("m1", 1), parts: [tool("m1", "t1", completed(0, 1)), t2, t3] },
    ])
    const after = computeActivityGroups([{ message: assistant("m1", 1), parts: [t2, t3] }])
    expect(before.byID.has("act-t1")).toBe(true)
    expect(after.byID.has("act-t1")).toBe(false)
    expect(after.byID.get("act-t2")?.items.map((item) => item.part.id)).toEqual(["t2", "t3"])
  })

  test("leaves non-tool conversations ungrouped", () => {
    const rows: ActivityRow[] = [
      { message: user("u1", 1), parts: [text("u1", "x1", "hello")] },
      { message: assistant("m1", 2), parts: [text("m1", "x2", "hi")] },
    ]
    const result = computeActivityGroups(rows)
    expect(result.byID.size).toBe(0)
    expect(result.groupOf.size).toBe(0)
  })
})

describe("summarizeActivity", () => {
  test("reports working state and no duration while a tool runs", () => {
    const summary = summarizeActivity([tool("m1", "t1", completed(0, 1)), tool("m1", "t2", running(1))])
    expect(summary).toEqual({ count: 2, working: true, failed: 0, denied: false, interrupted: false, durationMs: undefined })
  })

  test("treats pending tools as working", () => {
    const summary = summarizeActivity([tool("m1", "t1", { status: "pending", input: {}, raw: "" })])
    expect(summary.working).toBe(true)
    expect(summary.durationMs).toBeUndefined()
  })

  test("computes duration across the whole group", () => {
    const summary = summarizeActivity([
      tool("m1", "t1", completed(100, 500)),
      tool("m2", "t2", completed(400, 900)),
      tool("m3", "t3", completed(800, 1420)),
    ])
    expect(summary.working).toBe(false)
    expect(summary.durationMs).toBe(1420 - 100)
  })

  test("counts hard failures only", () => {
    const summary = summarizeActivity([
      tool("m1", "t1", completed(0, 1)),
      tool("m1", "t2", failed(1, 2, "boom")),
      tool("m1", "t3", failed(2, 3, "QuestionRejectedError")),
      tool("m1", "t4", failed(3, 4, "Tool execution aborted")),
    ])
    expect(summary.failed).toBe(1)
    expect(summary.denied).toBe(true)
    expect(summary.interrupted).toBe(true)
    expect(summary.durationMs).toBe(4 - 0)
  })
})

describe("activityHeader", () => {
  test("renders the active state with a count", () => {
    const header = activityHeader(
      { count: 3, working: true, failed: 0, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header).toEqual({ marker: "▸", main: "Working... 3 tool calls", failed: undefined, note: undefined })
  })

  test("surfaces failures while working", () => {
    const header = activityHeader(
      { count: 3, working: true, failed: 2, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header.main).toBe("Working... 3 tool calls")
    expect(header.failed).toBe("2 failed")
  })

  test("renders the completed state with duration and count", () => {
    const header = activityHeader(
      { count: 9, working: false, failed: 0, denied: false, interrupted: false, durationMs: 4200 },
      { expanded: false, duration: "4.2s" },
    )
    expect(header).toEqual({ marker: "▸", main: "Worked for 4.2s · 9 tool calls", failed: undefined, note: undefined })
  })

  test("pluralizes a single tool call", () => {
    const header = activityHeader(
      { count: 1, working: false, failed: 0, denied: false, interrupted: false, durationMs: 4200 },
      { expanded: false, duration: "4.2s" },
    )
    expect(header.main).toBe("Worked for 4.2s · 1 tool call")
  })

  test("omits the duration when timing data is unavailable", () => {
    const header = activityHeader(
      { count: 2, working: false, failed: 0, denied: false, interrupted: false, durationMs: undefined },
      { expanded: false, duration: undefined },
    )
    expect(header.main).toBe("2 tool calls")
  })

  test("flags completed groups that contain failures", () => {
    const header = activityHeader(
      { count: 5, working: false, failed: 1, denied: false, interrupted: false, durationMs: 1000 },
      { expanded: false, duration: "1.0s" },
    )
    expect(header.main).toBe("Worked for 1.0s · 5 tool calls")
    expect(header.failed).toBe("1 failed")
  })

  test("notes interrupted and denied groups", () => {
    const interrupted = activityHeader(
      { count: 2, working: false, failed: 0, denied: false, interrupted: true, durationMs: 1000 },
      { expanded: true, duration: "1.0s" },
    )
    expect(interrupted).toMatchObject({ marker: "▾", note: "interrupted" })
    const denied = activityHeader(
      { count: 2, working: false, failed: 0, denied: true, interrupted: false, durationMs: 1000 },
      { expanded: false, duration: "1.0s" },
    )
    expect(denied).toMatchObject({ marker: "▸", note: "denied" })
  })
})
