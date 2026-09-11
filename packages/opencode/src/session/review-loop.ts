import { SessionV1 } from "@opencode-ai/core/v1/session"

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none"

const REVIEW_VERDICT = /\*\*Ready to proceed\?\*\*\s*(?:\[[^\]]*\]\s*)?(Approved|Needs fixes)\b/i

export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none"> | undefined {
  const match = output.match(REVIEW_VERDICT)
  if (!match?.[1]) return undefined
  return match[1].toLowerCase() === "approved" ? "approved" : "needs-fixes"
}

function isToolPart(part: SessionV1.Part): part is SessionV1.ToolPart {
  return part.type === "tool"
}

function isReviewTask(part: SessionV1.Part): part is SessionV1.ToolPart {
  if (!isToolPart(part) || part.tool !== "task") return false
  if (typeof part.state.input !== "object" || part.state.input === null) return false
  return (part.state.input as Record<string, unknown>).subagent_type === "review"
}

/**
 * The finish gate is intentionally derived from persisted parent-session history.
 * A model cannot clear a review obligation by simply deciding that it is done.
 *
 * Once a review has approved the work, any later tool call invalidates that
 * approval. This makes the approval a real completion boundary: work, tests,
 * edits, or another task after approval must be followed by a fresh review.
 */
export function latestReviewVerdict(messages: readonly SessionV1.WithParts[]): ReviewVerdict {
  let postReviewTool = false

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex]?.parts ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (!part) continue

      if (isReviewTask(part)) {
        if (postReviewTool) return "pending"
        if (part.state.status !== "completed") return "pending"
        const output = typeof part.state.output === "string" ? part.state.output : ""
        return parseReviewVerdict(output) ?? "pending"
      }

      if (isToolPart(part) && part.tool !== "finish") postReviewTool = true
    }
  }

  return "none"
}

export function finishGateError(verdict: ReviewVerdict): Error | undefined {
  if (verdict === "needs-fixes") {
    return new Error(
      "Review gate: the latest review returned Needs fixes. Address the findings and run a new synchronous review before calling finish.",
    )
  }
  if (verdict === "pending") {
    return new Error("Review gate: the latest review is not an explicit approval for the current work. Run a fresh review before calling finish.")
  }
  return undefined
}
