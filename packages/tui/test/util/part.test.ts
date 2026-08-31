import { expect, test } from "bun:test"
import type { Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { applyPartDelta, applyPartUpdated, mergePartText } from "../../src/util/part"

function reasoning(overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "reasoning",
    text: "",
    time: { start: 1 },
    ...overrides,
  }
}

function text(overrides: Partial<TextPart> = {}): TextPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text: "",
    ...overrides,
  }
}

test("preserves streamed reasoning text when an empty snapshot arrives", () => {
  const current = reasoning({ text: "already streamed chain of thought" })
  const incoming = reasoning({ text: "" })
  expect(mergePartText(current, incoming)).toEqual({ ...incoming, text: current.text })
})

test("keeps the incoming reasoning snapshot when it is non-empty", () => {
  const current = reasoning({ text: "partial" })
  const incoming = reasoning({ text: "partial full text" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("preserves streamed reasoning text while adopting the incoming time", () => {
  const current = reasoning({ text: "thought", time: { start: 1 } })
  const incoming = reasoning({ text: "", time: { start: 1, end: 10 } })
  expect(mergePartText(current, incoming)).toEqual({
    ...incoming,
    text: "thought",
    time: { start: 1, end: 10 },
  })
})

test("preserves streamed text-part text when an empty snapshot arrives", () => {
  const current = text({ text: "streamed answer" })
  const incoming = text({ text: "" })
  expect(mergePartText(current, incoming)).toEqual({ ...incoming, text: "streamed answer" })
})

test("adopts the incoming text-part snapshot when it is non-empty", () => {
  const current = text({ text: "streamed" })
  const incoming = text({ text: "finalized answer" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("accepts the empty snapshot when nothing was streamed yet", () => {
  const current = reasoning({ text: "" })
  const incoming = reasoning({ text: "" })
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("accepts the incoming snapshot when there is no existing part", () => {
  const incoming = reasoning({ text: "fresh" })
  expect(mergePartText(undefined, incoming)).toBe(incoming)
})

test("leaves non-streamed part types untouched", () => {
  const current: Part = { id: "part-1", sessionID: "s", messageID: "m", type: "step-start" }
  const incoming: Part = { id: "part-1", sessionID: "s", messageID: "m", type: "step-start" }
  expect(mergePartText(current, incoming)).toBe(incoming)
})

test("part updated reducer seeds the part list when none exists", () => {
  expect(applyPartUpdated(undefined, reasoning({ text: "" }))).toEqual([reasoning({ text: "" })])
})

test("part updated reducer inserts a new part in id order", () => {
  const parts = applyPartUpdated(undefined, { ...reasoning(), id: "part-2" })
  const next = applyPartUpdated(parts, { ...reasoning(), id: "part-1" })
  expect(next.map((part) => part.id)).toEqual(["part-1", "part-2"])
})

test("part updated reducer preserves streamed text across a live event sequence", () => {
  // reasoning-start: the durable snapshot is persisted with empty text.
  let parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  expect(parts[0].text).toBe("")

  // message.part.delta: live deltas append to the part.
  parts = applyPartDelta(parts, "part-1", "text", "hello")!
  parts = applyPartDelta(parts, "part-1", "text", " world")!
  expect(parts[0].text).toBe("hello world")

  // message.part.updated: a stale empty snapshot arrives after streaming.
  parts = applyPartUpdated(parts, reasoning({ text: "", time: { start: 1, end: 10 } }))

  expect(parts[0].text).toBe("hello world")
  expect((parts[0] as ReasoningPart).time.end).toBe(10)
})

test("part updated reducer applies a non-empty snapshot verbatim", () => {
  let parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  parts = applyPartDelta(parts, "part-1", "text", "partial")!
  parts = applyPartUpdated(parts, reasoning({ text: "partial full text" }))
  expect(parts[0].text).toBe("partial full text")
})

test("part delta reducer returns undefined when there is no part to append to", () => {
  expect(applyPartDelta(undefined, "part-1", "text", "x")).toBeUndefined()
  const parts = applyPartUpdated(undefined, reasoning({ text: "" }))
  expect(applyPartDelta(parts, "missing", "text", "x")).toBeUndefined()
})
