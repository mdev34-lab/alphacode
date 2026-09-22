import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "@/tool/finish"

describe("tool.finish termination reason", () => {
  test.each(["success", "subagent_wait", "failure"] as const)("accepts %s", (reason) => {
    expect(Schema.decodeUnknownSync(Parameters)({ reason, result: "done" })).toEqual({ reason, result: "done" })
  })

  test("rejects unknown reasons", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ reason: "cancelled", result: "done" })).toThrow()
  })

  test("requires a reason", () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ result: "done" })).toThrow()
  })
})
