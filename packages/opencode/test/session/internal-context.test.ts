import { describe, it, expect } from "bun:test"
import { isInternalContextPart, stripInternalContextParts, type WithParts } from "@opencode-ai/schema/v1/session"

// This file lives under `packages/opencode/test` rather than beside the predicate in
// `packages/schema/test` because the schema package has no `test` script and no turbo task, so a test
// there is never executed by CI. The predicate is the contract every consumer depends on, including
// the deliberate synthetic-less arm below, so its coverage has to live in a suite that actually runs.

type ContextPart = Parameters<typeof isInternalContextPart>[0]

// The guard reads only `type` and `metadata`, so the fixtures stay structural rather than
// spelling out every field of the `Part` union.
const part = (value: Record<string, unknown>) => value as ContextPart

const text = (extra: Record<string, unknown> = {}) => part({ type: "text", text: "hello", ...extra })

const message = (parts: Array<Record<string, unknown>>) =>
  ({ info: { role: "user", id: "msg_1", sessionID: "ses_1" }, parts }) as unknown as WithParts

describe("isInternalContextPart", () => {
  it("matches a compaction part regardless of any other field", () => {
    expect(isInternalContextPart(part({ type: "compaction", auto: true }))).toBe(true)
    expect(isInternalContextPart({ type: "compaction" })).toBe(true)
  })

  it("matches the synthetic compaction_continue text marker", () => {
    expect(isInternalContextPart(text({ synthetic: true, metadata: { compaction_continue: true } }))).toBe(true)
  })

  it("matches a compaction_continue text marker without the synthetic flag", () => {
    // The marker is the signal. Requiring `synthetic` as well would couple the guard to one
    // producer, and a continuation that skipped the flag would leak unnoticed.
    expect(isInternalContextPart(text({ metadata: { compaction_continue: true } }))).toBe(true)
  })

  it("does not match synthetic text that is not a continuation marker", () => {
    // MCP resource reads and background-task notices are synthetic but real conversation.
    expect(isInternalContextPart(text({ synthetic: true }))).toBe(false)
    expect(isInternalContextPart(text({ synthetic: true, metadata: { other: true } }))).toBe(false)
    expect(isInternalContextPart(text({ synthetic: true, metadata: { compaction_continue: false } }))).toBe(false)
  })

  it("does not match a bare compaction_continue on a non-text part", () => {
    expect(isInternalContextPart(part({ type: "reasoning", metadata: { compaction_continue: true } }))).toBe(false)
    expect(isInternalContextPart(part({ type: "tool", metadata: { compaction_continue: true } }))).toBe(false)
  })

  it("does not match plain text with no metadata", () => {
    expect(isInternalContextPart(text())).toBe(false)
    expect(isInternalContextPart({ type: "text" })).toBe(false)
  })
})

describe("stripInternalContextParts", () => {
  it("passes a message with no internal parts through unchanged", () => {
    const input = message([text(), { type: "tool", tool: "read", callID: "call_1" }])
    expect(stripInternalContextParts(input)).toBe(input)
  })

  it("returns undefined for a marker-only message", () => {
    expect(stripInternalContextParts(message([{ type: "compaction", auto: true }]))).toBeUndefined()
    expect(
      stripInternalContextParts(message([text({ synthetic: true, metadata: { compaction_continue: true } })])),
    ).toBeUndefined()
  })

  it("keeps a marker message that still holds a tool result so pairing survives", () => {
    const result = { type: "tool", tool: "read", callID: "call_1" }
    const stripped = stripInternalContextParts(message([{ type: "compaction", auto: true }, result, text()]))
    expect(stripped?.parts as unknown[]).toEqual([result, text()])
  })
})
