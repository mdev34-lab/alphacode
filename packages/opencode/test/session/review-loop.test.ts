import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { finishGateError, latestReviewVerdict, parseReviewVerdict, reviewLoopState } from "../../src/session/review-loop"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")

const readPrompt = (name: string) => readFile(path.join(directory, name), "utf8")

function userMessage() {
  return { info: { role: "user" }, parts: [] } as unknown as SessionV1.WithParts
}

function syntheticNudge() {
  return {
    info: { role: "user" },
    parts: [{ type: "text", synthetic: true, text: "Continue." }],
  } as unknown as SessionV1.WithParts
}

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

  test("requires review for a mutating turn even when no review exists yet", () => {
    const state = reviewLoopState([userMessage(), toolMessage("edit")])

    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("allows no-tool turns to finish without review", () => {
    const state = reviewLoopState([userMessage()])

    expect(state.verdict).toBe("none")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("does not treat a synthetic continuation nudge as a new turn", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const state = reviewLoopState([userMessage(), toolMessage("edit"), approved, syntheticNudge()])

    expect(state.verdict).toBe("approved")
  })

  test("keeps a Needs fixes obligation until a later review explicitly approves", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    const findingsState = reviewLoopState([userMessage(), toolMessage("edit"), findings])
    const approvedState = reviewLoopState([userMessage(), toolMessage("edit"), findings, toolMessage("edit"), approved])

    expect(findingsState.verdict).toBe("needs-fixes")
    expect(finishGateError(findingsState)).toBeInstanceOf(Error)
    expect(approvedState.verdict).toBe("approved")
    expect(finishGateError(approvedState)).toBeUndefined()
  })

  test("invalidates approval after later mutating work but not read-only inspection", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(latestReviewVerdict([userMessage(), toolMessage("edit"), approved, toolMessage("read")])).toBe("approved")
    expect(latestReviewVerdict([userMessage(), toolMessage("edit"), approved, toolMessage("edit")])).toBe("pending")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("edit"), approved, toolMessage("edit")]))).toBeInstanceOf(Error)
  })

  test("stops at the configured cap after completed non-approval reviews", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const secondFindings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")

    const state = reviewLoopState(
      [userMessage(), toolMessage("edit"), findings, toolMessage("edit"), secondFindings],
      2,
    )

    expect(state.verdict).toBe("cap")
    expect(state.reviews).toBe(2)
    expect(state.maxIterations).toBe(2)
    expect(finishGateError(state)).toBeUndefined()
  })

  test("does not treat an incomplete or malformed review as approval", () => {
    const running = reviewMessage("", "running")
    const malformed = reviewMessage("review failed before producing an assessment")

    expect(latestReviewVerdict([userMessage(), toolMessage("edit"), running])).toBe("pending")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("edit"), running]))).toBeInstanceOf(Error)
    expect(latestReviewVerdict([userMessage(), toolMessage("edit"), malformed])).toBe("pending")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("edit"), malformed]))).toBeInstanceOf(Error)
  })
})
