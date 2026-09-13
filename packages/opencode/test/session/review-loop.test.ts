import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { REVIEW_LOOP_METADATA } from "@opencode-ai/core/review-loop"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { finishGateError, parseReviewVerdict, reviewLoopState } from "../../src/session/review-loop"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"

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

function finishNudgeMessage() {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "finish",
        state: {
          status: "error",
          input: { result: "done" },
          error: "Review nudge",
          metadata: { review: { nudged: true, verdict: "pending", reviews: 0, maxIterations: 5 } },
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

function toolMessage(tool: string, options?: { writesFiles?: boolean }) {
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
          ...(options?.writesFiles ? { metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } } } : {}),
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

describe("review loop prompt contract", () => {
  test("recommends a review after work that follows review findings", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("After every Work pass made in response to findings, return to Review")
    expect(prompt).toContain("Prefer not to call `finish` until a later review explicitly approves")
    expect(prompt).toContain("review-cap")
  })

  test("presents review as a nudge the agent may explicitly skip", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("Review is guidance, not an enforcement gate")
    expect(prompt).toContain("call `finish` again to explicitly skip review")
    expect(prompt).not.toContain("Mandatory Review Loop")
  })

  test("finish nudge preserves the review recommendation and the skip path", async () => {
    const nudge = await readPrompt("finish-nudge.txt")

    expect(nudge).toContain("synchronous `review` task")
    expect(nudge).toContain("latest review returned `Needs fixes`")
    expect(nudge).toContain("call `finish` again to explicitly skip review")
    expect(nudge).toContain("review-cap")
  })

  test("finish evaluates persisted history and fails the tool call when the gate blocks", async () => {
    const finish = await readTool("finish.ts")

    expect(finish).toContain("ctx.waitForOtherTools ?? Effect.void")
    expect(finish).toContain(".messages({ sessionID: ctx.sessionID })")
    expect(finish).toContain("return yield* Effect.fail(new ToolFailure({ message: gateError.message }))")
    expect(finish).not.toContain("Effect.orDie")
    expect(finish).not.toContain('termination: "blocked"')
  })

  test("file-writing tools advertise writes-files metadata", () => {
    expect(EditTool.metadata).toEqual({ writesFiles: true, mutates: true })
    expect(WriteTool.metadata).toEqual({ writesFiles: true, mutates: true })
    expect(ApplyPatchTool.metadata).toEqual({ writesFiles: true, mutates: true })
  })
})

describe("runtime review gate", () => {
  test("parses the last explicit review verdict without depending on one markdown shape", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("Assessment: Approved")).toBe("approved")
    expect(parseReviewVerdict("- Verdict — Needs fixes")).toBe("needs-fixes")
    expect(
      parseReviewVerdict("### Prior assessment\n\nAssessment: Approved\n\n### Assessment\n\nAssessment: Needs fixes"),
    ).toBe("needs-fixes")
    expect(parseReviewVerdict("Assessment: [Approved | Needs fixes]")).toBeUndefined()
    expect(parseReviewVerdict("Assessment: Approved (no Needs fixes remain)")).toBe("approved")
    expect(parseReviewVerdict("The implementation looks good, but no final assessment was emitted.")).toBeUndefined()
  })

  test("allows no-tool turns to finish without review", () => {
    const state = reviewLoopState([userMessage()])

    expect(state.verdict).toBe("none")
    expect(finishGateError(state)).toBeUndefined()
  })

  test("allows read-only tool turns to finish without review", () => {
    expect(reviewLoopState([userMessage(), toolMessage("read")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("bash")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("grep")]).verdict).toBe("none")
    expect(reviewLoopState([userMessage(), toolMessage("future_writer")]).verdict).toBe("none")
    expect(finishGateError(reviewLoopState([userMessage(), toolMessage("bash")]))).toBeUndefined()
  })

  test("nudges review for tools that declare file writes even when no review exists yet", () => {
    for (const tool of ["edit", "write", "apply_patch", "future_writer"]) {
      const state = reviewLoopState([userMessage(), toolMessage(tool, { writesFiles: true })])
      expect(state.verdict).toBe("pending")
      expect(state.nudged).toBe(false)
      expect(finishGateError(state)).toBeInstanceOf(Error)
      expect(finishGateError(state)?.message).toContain("call finish again to skip review")
    }
  })

  test("lets a second finish call skip review after a nudge", () => {
    const state = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), finishNudgeMessage()])

    expect(state.verdict).toBe("pending")
    expect(state.nudged).toBe(true)
    expect(finishGateError(state)).toBeUndefined()
  })

  test("lets a second finish call skip review after needs-fixes findings", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      findings,
      finishNudgeMessage(),
    ])

    expect(state.verdict).toBe("needs-fixes")
    expect(state.nudged).toBe(true)
    expect(finishGateError(state)).toBeUndefined()
  })

  test("new file writes after a nudge start a fresh nudge", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      toolMessage("edit", { writesFiles: true }),
    ])

    expect(state.nudged).toBe(false)
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("a review after a nudge resets the nudge and is honoured", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      findings,
    ])

    expect(state.nudged).toBe(false)
    expect(state.verdict).toBe("needs-fixes")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("does not carry a nudge across user turns", () => {
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      finishNudgeMessage(),
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
    ])

    expect(state.nudged).toBe(false)
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("surfaces a skipped termination from a completed finish", () => {
    const skipped = {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "finish",
          state: { status: "completed", input: {}, output: "done", metadata: { review: { termination: "skipped" } } },
        },
      ],
    } as unknown as SessionV1.WithParts

    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), finishNudgeMessage(), skipped])
        .termination,
    ).toBe("skipped")
  })

  test("requires an explicit synchronous review", () => {
    const background = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved", { background: true })
    const synchronous = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), background]).verdict).toBe(
      "pending",
    )
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), synchronous]).verdict).toBe(
      "approved",
    )
  })

  test("does not treat a synthetic continuation nudge as a new turn", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const state = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      approved,
      syntheticNudge(),
    ])

    expect(state.verdict).toBe("approved")
  })

  test("forces two work/review cycles when the first review finds fixes", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const fixed = toolMessage("edit", { writesFiles: true })
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    const firstCycle = reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), findings])
    const secondCycle = reviewLoopState([
      userMessage(),
      toolMessage("edit", { writesFiles: true }),
      findings,
      fixed,
      approved,
    ])

    expect(firstCycle.reviews).toBe(1)
    expect(firstCycle.verdict).toBe("needs-fixes")
    expect(finishGateError(firstCycle)).toBeInstanceOf(Error)
    expect(secondCycle.reviews).toBe(2)
    expect(secondCycle.verdict).toBe("approved")
    expect(finishGateError(secondCycle)).toBeUndefined()
  })

  test("ignores earlier user turns when deriving the current review gate", () => {
    const earlierApproved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")
    const earlierTurn = [userMessage(), toolMessage("edit", { writesFiles: true }), earlierApproved]
    const currentTurn = [userMessage(), toolMessage("edit", { writesFiles: true })]
    const state = reviewLoopState([...earlierTurn, ...currentTurn])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
  })

  test("requires review only for declared file-writing tools", () => {
    const approved = reviewMessage("### Assessment\n\n**Ready to proceed?** Approved")

    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("read")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("read")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), approved, toolMessage("bash")])
        .verdict,
    ).toBe("approved")
    expect(
      reviewLoopState([
        userMessage(),
        toolMessage("edit", { writesFiles: true }),
        approved,
        toolMessage("edit", { writesFiles: true }),
      ]).verdict,
    ).toBe("pending")
    expect(
      finishGateError(
        reviewLoopState([
          userMessage(),
          toolMessage("edit", { writesFiles: true }),
          approved,
          toolMessage("edit", { writesFiles: true }),
        ]),
      ),
    ).toBeInstanceOf(Error)
  })

  test("stops at the configured cap after completed non-approval reviews", () => {
    const findings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")
    const secondFindings = reviewMessage("### Assessment\n\n**Ready to proceed?** Needs fixes")

    const state = reviewLoopState(
      [
        userMessage(),
        toolMessage("edit", { writesFiles: true }),
        findings,
        toolMessage("edit", { writesFiles: true }),
        secondFindings,
      ],
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

    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), running]).verdict).toBe(
      "pending",
    )
    expect(
      finishGateError(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), running])),
    ).toBeInstanceOf(Error)
    expect(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), malformed]).verdict).toBe(
      "pending",
    )
    expect(
      finishGateError(reviewLoopState([userMessage(), toolMessage("edit", { writesFiles: true }), malformed])),
    ).toBeInstanceOf(Error)
  })
})
