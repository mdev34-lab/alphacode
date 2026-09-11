import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { finishGateError, parseReviewVerdict, reviewLoopState } from "../../src/session/review-loop"

const promptDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")
const toolDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/tool")

const readPrompt = (name: string) => readFile(path.join(promptDirectory, name), "utf8")
const readTool = (name: string) => readFile(path.join(toolDirectory, name), "utf8")

function userMessage() {
  return { info: { role: "user" }, parts: [] } as unknown as SessionV1.WithParts
}

function syntheticNudge() {
  return {
    info: { role: "user" },
    parts: [{ type: "text", synthetic: true, text: "Continue." }],
  } as unknown as SessionV1.WithParts
}

function reviewMessage(output: string, options?: { status?: "completed" | "running"; background?: boolean }) {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: options?.status ?? "completed",
          input: { subagent_type: "review", background: options?.background ?? false },
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

  test("finish evaluates persisted history and fails the tool call when the gate blocks", async () => {
    const finish = await readTool("finish.ts")

    expect(finish).toContain("sessions.messages({ sessionID: ctx.sessionID })")
    expect(finish).toContain("return yield* Effect.fail(gateError).pipe(Effect.orDie)")
    expect(finish).not.toContain('termination: "blocked"')
  })
})

describe("runtime review gate", () => {
  test("parses the last explicit review verdict", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Needs fixes")).toBe("needs-fixes")
    expect(
      parseReviewVerdict(
        "### Prior assessment\n\n**Ready to proceed?** Approved\n\n### Assessment\n\n**Ready to proceed?** Needs fixes",
      ),
    ).toBe("needs-fixes")
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

  test("requires an explicit synchronous review", () => {
    const background = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", { background: true })
    const synchronous = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(reviewLoopState([userMessage(), toolMessage("edit"), background]).verdict).toBe("pending")
    expect(reviewLoopState([userMessage(), toolMessage("edit"), synchronous]).verdict).toBe("approved")
  })

  test("does not treat a synthetic continuation nudge as a new turn", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const state = reviewLoopState([userMessage(), toolMessage("edit"), approved, syntheticNudge()])

    expect(state.verdict).toBe("approved")
  })

  test("forces two work/review cycles when the first review finds fixes", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const fixed = toolMessage("edit")
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    const firstCycle = reviewLoopState([userMessage(), toolMessage("edit"), findings])
    const secondCycle = reviewLoopState([userMessage(), toolMessage("edit"), findings, fixed, approved])

    expect(firstCycle.reviews).toBe(1)
    expect(firstCycle.verdict).toBe("needs-fixes")
    expect(finishGateError(firstCycle)).toBeInstanceOf(Error)
    expect(secondCycle.reviews).toBe(2)
    expect(secondCycle.verdict).toBe("approved")
    expect(finishGateError(secondCycle)).toBeUndefined()
  })

  test("ignores earlier user turns when deriving the current review gate", () => {
    const earlierApproved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const earlierTurn = [userMessage(), toolMessage("edit"), earlierApproved]
    const currentTurn = [userMessage(), toolMessage("edit")]
    const state = reviewLoopState([...earlierTurn, ...currentTurn])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
  })

  test("invalidates approval after later mutating work but not read-only inspection", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(reviewLoopState([userMessage(), toolMessage("edit"), approved, toolMessage("read")]).verdict).toBe("approved")
    expect(reviewLoopState([userMessage(), toolMessage("edit"), approved, toolMessage("edit")]).verdict).toBe("pending")
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
    const running = reviewMessage("", { status: "running" })
    const malformed = reviewMessage("review failed before producing an assessment")

    expect(reviewLoopState([userMessage(), toolMessage("edit"), running]).verdict).toBe("pending")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("edit"), running]))).toBeInstanceOf(Error)
    expect(reviewLoopState([userMessage(), toolMessage("edit"), malformed]).verdict).toBe("pending")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("edit"), malformed]))).toBeInstanceOf(Error)
  })
})
