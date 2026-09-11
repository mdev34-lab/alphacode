import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { finishGateError, latestReviewVerdict, parseReviewVerdict } from "../../src/session/review-loop"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")

const readPrompt = (name: string) => readFile(path.join(directory, name), "utf8")

function reviewMessage(output: string, status: "completed" | "running" = "completed") {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status,
          input: { subagent_type: "review" },
          output,
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

function toolMessage(tool: string) {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool,
        state: {
          status: "completed",
          input: {},
          output: "done",
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

describe("mandatory review loop prompt contract", () => {
  test("requires a review after work that follows review findings", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("WORK → REVIEW → APPROVED → FINISH")
    expect(prompt).toContain("NEEDS FIXES → WORK → REVIEW")
    expect(prompt).toContain("After every Work pass performed in response to review findings, dispatch Review again")
    expect(prompt).toContain("Only after an explicit `Approved` review may you call `finish`")
    expect(prompt).toContain("review-cap")
  })

  test("finish nudge preserves the review gate", async () => {
    const nudge = await readPrompt("finish-nudge.txt")

    expect(nudge).toContain("outstanding `Needs fixes` verdict")
    expect(nudge).toContain("dispatch the read-only `review` subagent again")
    expect(nudge).toContain("explicit `Approved` verdict")
  })
})

describe("runtime review gate", () => {
  test("parses only the reviewer's final verdict", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Needs fixes")).toBe("needs-fixes")
    expect(parseReviewVerdict("The implementation looks good, but no final assessment was emitted.")).toBeUndefined()
  })

  test("keeps a Needs fixes obligation until a later review explicitly approves", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(latestReviewVerdict([findings])).toBe("needs-fixes")
    expect(finishGateError(latestReviewVerdict([findings]))).toBeInstanceOf(Error)
    expect(latestReviewVerdict([findings, approved])).toBe("approved")
    expect(finishGateError(latestReviewVerdict([findings, approved]))).toBeUndefined()
  })

  test("invalidates an approval if any later non-finish tool ran", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const edit = toolMessage("edit")

    expect(latestReviewVerdict([approved, edit])).toBe("pending")
    expect(finishGateError(latestReviewVerdict([approved, edit]))).toBeInstanceOf(Error)
    expect(latestReviewVerdict([approved, toolMessage("finish")])).toBe("approved")
  })

  test("does not treat an incomplete or malformed review as approval", () => {
    const running = reviewMessage("", "running")
    const malformed = reviewMessage("review failed before producing an assessment")

    expect(latestReviewVerdict([running])).toBe("pending")
    expect(finishGateError(latestReviewVerdict([running]))).toBeInstanceOf(Error)
    expect(latestReviewVerdict([malformed])).toBe("pending")
    expect(finishGateError(latestReviewVerdict([malformed]))).toBeInstanceOf(Error)
  })
})
