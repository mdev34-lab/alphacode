import { SessionV1 } from "@opencode-ai/core/v1/session"

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none" | "cap"

export type ReviewLoopState = {
  verdict: ReviewVerdict
  reviews: number
  maxIterations: number
  workSinceReview: boolean
}

type HistoryPart = {
  type?: unknown
  tool?: unknown
  state?: {
    status?: unknown
    input?: unknown
    output?: unknown
  }
}

const REVIEW_VERDICT = /\*\*Ready to proceed\?\*\*\s*(?:\[[^\]]*\]\s*)?(Approved|Needs fixes)\b/gi
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

function historyPart(part: SessionV1.WithParts["parts"][number]): HistoryPart {
  return part as unknown as HistoryPart
}

export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined {
  const matches = [...output.matchAll(REVIEW_VERDICT)]
  const verdict = matches.at(-1)?.[1]
  if (!verdict) return undefined
  return verdict.toLowerCase() === "approved" ? "approved" : "needs-fixes"
}

function isReviewTask(part: HistoryPart) {
  if (part.type !== "tool" || part.tool !== "task") return false
  if (typeof part.state?.input !== "object" || part.state.input === null) return false
  const input = part.state.input as Record<string, unknown>
  return input.subagent_type === "review"
}

function isSynchronousReviewTask(part: HistoryPart) {
  return (
    isReviewTask(part) &&
    typeof part.state?.input === "object" &&
    part.state.input !== null &&
    (part.state.input as Record<string, unknown>).background === false
  )
}

function isPotentiallyMutatingTool(part: HistoryPart) {
  if (part.type !== "tool" || typeof part.tool !== "string") return false
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
    for (const rawPart of message.parts) {
      const part = historyPart(rawPart)

      if (isReviewTask(part)) {
        if (!isSynchronousReviewTask(part)) continue
        if (part.state?.status !== "completed") {
          latest = undefined
          workSinceReview = true
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
