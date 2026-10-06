import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Parameters, TerminationReason, readTermination } from "@/tool/finish"

function finishPart(input: unknown, status: SessionV1.ToolState["status"] = "completed") {
  return {
    id: "prt_finish",
    messageID: "msg_assistant",
    sessionID: "ses_test",
    type: "tool",
    tool: "finish",
    callID: "call_finish",
    state: { status, input },
  } as unknown as SessionV1.ToolPart
}

describe("tool.finish termination reason", () => {
  test.each(["success", "subagent_wait", "failure"] as const)("accepts %s", (reason) => {
    expect(Schema.decodeUnknownSync(Parameters)({ reason, result: "done" })).toEqual({ reason, result: "done" })
  })

  test("rejects unknown reasons", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ reason: "aborted", result: "done" })).toThrow()
  })

  // Cancellation is a runtime outcome recorded by the tool, never something the
  // model declares: a cancelled child is stopped mid-run and reaches no finish
  // call at all. The finish input therefore still refuses it even though the
  // delivered termination contract carries it.
  test("rejects a runtime-only reason", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ reason: "cancelled", result: "done" })).toThrow()
  })

  test("requires a reason", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ result: "done" })).toThrow()
  })
})

describe("tool.finish termination contract", () => {
  test.each(["success", "subagent_wait", "failure", "cancelled"] as const)("carries %s", (reason) => {
    expect(Schema.decodeUnknownSync(TerminationReason)(reason)).toBe(reason)
  })

  test("rejects a value outside the contract", () => {
    expect(() => Schema.decodeUnknownSync(TerminationReason)("aborted")).toThrow()
  })
})

describe("readTermination", () => {
  test.each(["success", "subagent_wait", "failure"] as const)("reads the declared %s", (reason) => {
    expect(readTermination(finishPart({ reason, result: "done" }))).toBe(reason)
  })

  // Transcripts written before the field existed had no reason to read. Those
  // turns were successes, so absence resolves to success rather than to
  // "unknown" — the loop still exits and the parent still gets a verdict.
  test("reads a pre-field transcript as success", () => {
    expect(readTermination(finishPart({ result: "done" }))).toBe("success")
  })

  // A reason this build does not know is not a legacy transcript, so it must not
  // silently resolve to success: an unrecognised value reports nothing and the
  // caller treats the termination as undelivered.
  test("returns undefined for an unrecognised reason", () => {
    expect(readTermination(finishPart({ reason: "aborted", result: "done" }))).toBeUndefined()
  })

  test("returns undefined for a non-object input", () => {
    expect(readTermination(finishPart("done"))).toBeUndefined()
  })

  test.each(["pending", "running", "error"] as const)("returns undefined while %s", (status) => {
    expect(readTermination(finishPart({ reason: "success", result: "done" }, status))).toBeUndefined()
  })

  test("returns undefined for a different tool", () => {
    const part = finishPart({ reason: "success", result: "done" })
    expect(readTermination({ ...part, tool: "task" } as SessionV1.ToolPart)).toBeUndefined()
  })
})
