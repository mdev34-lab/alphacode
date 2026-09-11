import { SessionV1 } from "@opencode-ai/core/v1/session"

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none" | "cap"

export type ReviewLoopState = {
  verdict: ReviewVerdict
  reviews: number
  maxIterations: number
  workSinceReview: boolean
}

const REVIEW_VERDICT = /\*\*Ready to proceed\?\*\*\s*(?:\[[^\]]*\]\s*)?(Approved|Needs fixes)\b/i
const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "lsp",
  "tool_search",
  "tool_search_regex",
  "question",
  "todo",
])

export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined {
  const match = output.match(REVIEW_VERDICT)
  if (!match?.[1]) return undefined
  return match[1].toLowerCase() === "approved" ? "approved" : "needs-fixes"
}

function isReviewTask(part: SessionV1.ToolPart) {
  if (part.tool !== "task") return false
  if (typeof part.state.input !== "object" || part.state.input === null) return false
  const input = part.state.input as Record<string, unknown>
  return input.subagent_type === "review" && input.background === false
}

function isPotentiallyMutatingTool(part: SessionV1.ToolPart) {
  if (part.tool === "finish" || isReviewTask(part)) return false
  return !READ_ONLY_TOOLS.has(part.tool)
}

function isSyntheticUser(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => "synthetic" in part && part.synthetic === true)
  )
}

/**
 * Derive the review gate from persisted parent-session history. Only a completed
 * synchronous review after the latest potentially-mutating operation can authorize finish.
 * Synthetic user messages inserted by the loop are continuation nudges, not new turns.
 */
export function reviewLoopState(messages: readonly SessionV1.WithParts[], maxIterations = 5): ReviewLoopState {
  const start = messages.findLastIndex((message) => message.info.role === "user" && !isSyntheticUser(message))
  const current = start < 0 ? messages : messages.slice(start + 1)

  let reviews = 0
  let workSeen = false
  let workSinceReview = false
  let latest: Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined

  for (const message of current) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue

      if (isReviewTask(part)) {
        if (part.state.status !== "completed") {
          latest = undefined
          continue
        }
        reviews++
        latest = parseReviewVerdict(typeof part.state.output === "string" ? part.state.output : "")
        workSinceReview = false
        continue
      }

      if (isPotentiallyMutatingTool(part)) {
        workSeen = true
        workSinceReview = true
        latest = undefined
      }
    }
  }

  if (!workSeen) return { verdict: "none", reviews, maxIterations, workSinceReview }
  if (!workSinceReview && latest === "approved") return { verdict: "approved", reviews, maxIterations, workSinceReview }
  if (!workSinceReview && reviews >= maxIterations) return { verdict: "cap", reviews, maxIterations, workSinceReview }
  if (latest === "needs-fixes") return { verdict: "needs-fixes", reviews, maxIterations, workSinceReview }
  return { verdict: "pending", reviews, maxIterations, workSinceReview }
}

export function finishGateError(state: ReviewLoopState): Error | undefined {
  if (state.verdict === "needs-fixes") {
    return new Error(
      "Review gate: the latest review returned Needs fixes. Address the findings and run a new synchronous review before calling finish.",
    )
  }
  if (state.verdict === "pending") {
    return new Error("Review gate: the current work has no explicit Approved review yet. Run a fresh review before calling finish.")
  }
  return undefined
}
