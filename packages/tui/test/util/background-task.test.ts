import { describe, expect, test } from "bun:test"
import { parseBackgroundResult } from "../../src/util/background-task"

const completed = [
  '<task id="ses_abc" state="completed">',
  "<summary>Background task completed: Review cache fix</summary>",
  "<task_result>",
  "Two findings.",
  "</task_result>",
  "</task>",
].join("\n")

const failed = [
  '<task id="ses_abc" state="error">',
  "<summary>Background task failed: Review cache fix</summary>",
  "<task_error>",
  "Worker crashed.",
  "</task_error>",
  "</task>",
].join("\n")

describe("parseBackgroundResult", () => {
  test("parses a completed background result", () => {
    expect(parseBackgroundResult(completed)).toEqual({
      state: "completed",
      summary: "Background task completed: Review cache fix",
    })
  })

  test("parses a failed background result", () => {
    expect(parseBackgroundResult(failed)).toEqual({
      state: "error",
      summary: "Background task failed: Review cache fix",
    })
  })

  test("ignores ordinary text", () => {
    expect(parseBackgroundResult("Looks good to me, ship it.")).toBeUndefined()
    expect(parseBackgroundResult("")).toBeUndefined()
  })

  test("rejects task markup without a state or summary", () => {
    expect(parseBackgroundResult('<task id="ses_abc">\n<summary>Hi</summary>\n</task>')).toBeUndefined()
    expect(parseBackgroundResult('<task id="ses_abc" state="completed">\nno summary\n</task>')).toBeUndefined()
    expect(parseBackgroundResult('<task id="ses_abc" state="running">\n<summary>Hi</summary>\n</task>')).toBeUndefined()
  })
})
