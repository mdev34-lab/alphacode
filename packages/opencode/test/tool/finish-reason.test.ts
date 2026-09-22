import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "@/tool/finish"

describe("finish termination reason", () => {
  const decode = Schema.decodeUnknownSync(Parameters)

  test("accepts each explicit termination reason", () => {
    expect(decode({ reason: "success", result: "done" })).toEqual({ reason: "success", result: "done" })
    expect(decode({ reason: "subagent_wait", result: "waiting" })).toEqual({
      reason: "subagent_wait",
      result: "waiting",
    })
    expect(decode({ reason: "failure", result: "blocked" })).toEqual({ reason: "failure", result: "blocked" })
  })

  test("rejects missing or unknown termination reasons", () => {
    expect(() => decode({ result: "done" })).toThrow()
    expect(() => decode({ reason: "unknown", result: "done" })).toThrow()
  })
})
