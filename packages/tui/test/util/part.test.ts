import { expect, test } from "bun:test"
import type { Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { mergePartText } from "../../src/util/part"

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
