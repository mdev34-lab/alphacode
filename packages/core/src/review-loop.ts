export const REVIEW_LOOP_METADATA = "reviewLoop" as const

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none" | "cap"
export type ReviewPhase = "work" | "review"
export type ReviewTermination = "approved" | "review-cap"

export type ReviewHistoryPart = {
  readonly type?: unknown
  readonly tool?: unknown
  readonly synthetic?: unknown
  readonly metadata?: unknown
  readonly state?: {
    readonly status?: unknown
    readonly input?: unknown
    readonly output?: unknown
    readonly metadata?: unknown
  }
}

/** The small, persisted history projection needed by the review-loop evaluator. */
export type ReviewHistoryMessage = {
  readonly role?: unknown
  readonly info?: { readonly role?: unknown }
  readonly parts: readonly ReviewHistoryPart[]
}

export type ReviewLoopState = {
  readonly verdict: ReviewVerdict
  readonly reviews: number
  readonly maxIterations: number
  readonly workSinceReview: boolean
  readonly reviewInProgress: boolean
  readonly phase: ReviewPhase
  readonly termination?: ReviewTermination
}

const ASSESSMENT = /(?:^|\b)(?:assessment|verdict)\s*(?:[:\-–—]\s*)?(approved|needs\s+fix(?:es)?)/gi
const READY_TO_PROCEED = /ready\s+to\s+proceed\??\s*(?:[:\-–—]\s*)?(approved|needs\s+fix(?:es)?)/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cleanAssessmentLine(line: string) {
  return line
    .replace(/[*_`#>]/g, " ")
    .replace(/[[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function verdictFromText(text: string) {
  // Do not treat the review template's `[Approved | Needs fixes]` placeholder as
  // an actual verdict. A report must name one outcome, not list both choices.
  if (
    /\bapproved\b\s*(?:\||\/|or)\s*\bneeds\s+fix(?:es)?\b/i.test(text) ||
    /\bneeds\s+fix(?:es)?\b\s*(?:\||\/|or)\s*\bapproved\b/i.test(text)
  )
    return undefined

  const matches = [...text.matchAll(ASSESSMENT), ...text.matchAll(READY_TO_PROCEED)].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  )
  const verdict = matches.at(-1)?.[1]
  if (!verdict) return undefined
  return /^approved$/i.test(verdict) ? ("approved" as const) : ("needs-fixes" as const)
}

/**
 * Read the last explicit assessment from a review report.
 *
 * Reports are written by a model, so formatting is deliberately tolerant: headings,
 * emphasis, bullets, and the labels "Assessment", "Verdict", and "Ready to proceed"
 * are all accepted. A positive-sounding paragraph without an explicit assessment is
 * not an approval.
 */
export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined {
  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = cleanAssessmentLine(lines[index] ?? "")
    const verdict = verdictFromText(line) ?? verdictFromText(`${line} ${cleanAssessmentLine(lines[index + 1] ?? "")}`)
    if (verdict) return verdict
  }
  return undefined
}

function messageRole(message: ReviewHistoryMessage) {
  return message.info?.role ?? message.role
}

function isSyntheticUser(message: ReviewHistoryMessage) {
  return (
    messageRole(message) === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.synthetic === true)
  )
}

function inputRecord(part: ReviewHistoryPart) {
  return isRecord(part.state?.input) ? part.state.input : undefined
}

function isReviewTask(part: ReviewHistoryPart) {
  return part.type === "tool" && part.tool === "task" && inputRecord(part)?.subagent_type === "review"
}

function isSynchronousReviewTask(part: ReviewHistoryPart) {
  return isReviewTask(part) && inputRecord(part)?.background === false
}

function isFileWritingTool(part: ReviewHistoryPart) {
  if (part.type !== "tool" || typeof part.tool !== "string") return false
  if (part.state?.status !== "completed") return false
  const metadata = {
    ...(isRecord(part.metadata) ? part.metadata : {}),
    ...(isRecord(part.state?.metadata) ? part.state.metadata : {}),
  }
  const reviewLoop = isRecord(metadata[REVIEW_LOOP_METADATA]) ? metadata[REVIEW_LOOP_METADATA] : undefined
  return reviewLoop?.writesFiles === true
}

function isPotentiallyMutatingTool(part: ReviewHistoryPart) {
  if (part.type !== "tool" || typeof part.tool !== "string") return false
  if (part.tool === "finish" || isReviewTask(part)) return false
  return isFileWritingTool(part)
}

function finishTermination(part: ReviewHistoryPart): ReviewTermination | undefined {
  if (part.type !== "tool" || part.tool !== "finish" || part.state?.status !== "completed") return undefined
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : undefined
  const review = isRecord(metadata?.review) ? metadata.review : undefined
  if (review?.termination === "approved" || review?.termination === "review-cap") return review.termination
  return undefined
}

/**
 * Evaluate the current user turn. Synthetic continuation messages are deliberately
 * ignored as turn boundaries so a review/fix cycle cannot reset its counter.
 * Only completed tools whose persisted metadata explicitly declares `writesFiles`
 * count as work that requires review. The declaration lives on the tool definition,
 * so a new file-writing tool is classified where it is defined. Unmarked tools,
 * including shell, do not trigger the review gate.
 */
export function reviewLoopState(messages: readonly ReviewHistoryMessage[], maxIterations = 5): ReviewLoopState {
  const max = Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : 1
  const start = messages.findLastIndex((message) => messageRole(message) === "user" && !isSyntheticUser(message))
  const current = start < 0 ? messages : messages.slice(start + 1)

  let reviews = 0
  let workSeen = false
  let workSinceReview = false
  let reviewInProgress = false
  let latest: Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined
  let termination: ReviewTermination | undefined

  for (const part of current.flatMap((message) => message.parts)) {
    if (isReviewTask(part)) {
      if (!isSynchronousReviewTask(part)) continue

      if (part.state?.status !== "completed") {
        latest = undefined
        workSinceReview = true
        reviewInProgress = part.state?.status === "pending" || part.state?.status === "running"
        termination = undefined
        continue
      }

      reviews++
      latest = parseReviewVerdict(typeof part.state.output === "string" ? part.state.output : "")
      workSinceReview = false
      reviewInProgress = false
      termination = undefined
      continue
    }

    const partTermination = finishTermination(part)
    if (partTermination) {
      termination = partTermination
      continue
    }

    if (isPotentiallyMutatingTool(part)) {
      workSeen = true
      workSinceReview = true
      reviewInProgress = false
      latest = undefined
      termination = undefined
    }
  }

  let verdict: ReviewVerdict
  if (!workSeen) verdict = "none"
  else if (!workSinceReview && latest === "approved") verdict = "approved"
  else if (!workSinceReview && reviews >= max) verdict = "cap"
  else if (latest === "needs-fixes") verdict = "needs-fixes"
  else verdict = "pending"

  const phase: ReviewPhase =
    reviewInProgress || verdict === "approved" || verdict === "cap" || (!workSinceReview && verdict === "pending")
      ? "review"
      : "work"

  return {
    verdict,
    reviews,
    maxIterations: max,
    workSinceReview,
    reviewInProgress,
    phase,
    ...(termination ? { termination } : {}),
  }
}

export function finishGateError(state: ReviewLoopState): Error | undefined {
  if (state.verdict === "needs-fixes") {
    return new Error(
      "Review gate: the latest review returned Needs fixes. Address the findings and run a new synchronous review before calling finish.",
    )
  }
  if (state.verdict === "pending") {
    return new Error(
      "Review gate: the current work has no explicit Approved review yet. Run a fresh review before calling finish.",
    )
  }
  return undefined
}
