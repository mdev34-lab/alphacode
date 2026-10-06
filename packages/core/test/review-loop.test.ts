/**
 * Regression tests for what the review-loop evaluator accepts as a delivered
 * review. A review task is only a verdict when the run actually reported one:
 * a cancelled run never reached a finish call, and a run that yielded for its
 * own background subagents has not finished, so its envelope is provisional.
 *
 * See packages/core/src/review-loop.ts for the evaluator and
 * packages/opencode/src/tool/task.ts for the delivered task metadata.
 */

import { describe, expect, test } from "bun:test"
import { REVIEW_LOOP_METADATA, finishGateError, reviewLoopState } from "@opencode-ai/core/review-loop"

type Part = {
  type?: unknown
  tool?: unknown
  synthetic?: unknown
  metadata?: unknown
  state?: {
    status?: unknown
    input?: unknown
    output?: unknown
    metadata?: unknown
  }
}

const userMessage = { info: { role: "user" }, parts: [] as Part[] }

const editMessage = {
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: {},
        output: "done",
        metadata: { [REVIEW_LOOP_METADATA]: { writesFiles: true } },
      },
    },
  ] as Part[],
}

const reviewMessage = (options?: { termination?: string; status?: string }) => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "task",
      state: {
        status: options?.status ?? "completed",
        input: { subagent_type: "review", background: false },
        output: "### Assessment\n\n**Ready to proceed?** Approved",
        ...(options?.termination ? { metadata: { termination: { reason: options.termination } } } : {}),
      },
    },
  ] as Part[],
})

const finishMessage = (termination: string) => ({
  info: { role: "assistant" },
  parts: [
    {
      type: "tool",
      tool: "finish",
      state: {
        status: "completed",
        input: { reason: "success", result: "done" },
        output: "done",
        metadata: { review: { verdict: "approved", reviews: 1, maxIterations: 5, termination } },
      },
    },
  ] as Part[],
})

describe("review loop – delivered reviews", () => {
  test("a completed synchronous review is the delivered verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage()])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
    expect(finishGateError(state)).toBeUndefined()
  })

  // The parent-facing task result carries the reason its child stopped. A child
  // that yielded is still running underneath, so the envelope it delivered
  // cannot stand in for a verdict: no completion was reported, and the review
  // it describes may still change. Counting it would let a review satisfy the
  // gate while it keeps working.
  test("a review that yielded for its own subagents delivers no verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage({ termination: "waiting_for_subagent" })])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  test("a cancelled review delivers no verdict", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage({ status: "cancelled" })])

    expect(state.reviews).toBe(0)
    expect(state.verdict).toBe("pending")
    expect(finishGateError(state)).toBeInstanceOf(Error)
  })

  // The counter-case: a review that stopped with a real termination is the
  // delivered verdict, so the excluded reasons are exactly the undelivered ones
  // rather than every reason-carrying task.
  test("a review that stopped on a declared reason still delivers its verdict", () => {
    for (const reason of ["success", "failure", "subagent_wait"]) {
      const state = reviewLoopState([userMessage, editMessage, reviewMessage({ termination: reason })])

      expect(state.reviews).toBe(1)
      expect(state.verdict).toBe("approved")
      expect(finishGateError(state)).toBeUndefined()
    }
  })

  // Discriminating counterpart to the excluded-reason cases: the evaluator does
  // read a terminal finish metadata, so a waiting review is skipped for its own
  // reason and not because every task part is ignored.
  test("a delivered approval is disturbed by neither a yielded nor a cancelled review", () => {
    const state = reviewLoopState([
      userMessage,
      editMessage,
      reviewMessage(),
      reviewMessage({ termination: "waiting_for_subagent" }),
      reviewMessage({ termination: "cancelled", status: "cancelled" }),
    ])

    expect(state.reviews).toBe(1)
    expect(state.verdict).toBe("approved")
  })

  test("a finish that recorded a terminal review keeps the termination", () => {
    const state = reviewLoopState([userMessage, editMessage, reviewMessage(), finishMessage("approved")])

    expect(state.termination).toBe("approved")
    expect(state.nudged).toBe(false)
  })
})
