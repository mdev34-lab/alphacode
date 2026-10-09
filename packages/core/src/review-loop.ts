import { ReviewReport } from "./review-report"

export const REVIEW_LOOP_METADATA = "reviewLoop" as const

export type ReviewVerdict = "approved" | "needs-fixes" | "pending" | "none" | "cap"
export type ReviewPhase = "work" | "review"
/**
 * How a finished turn left the review loop.
 *
 * - `approved`: the work carries an explicit Approved review, or the turn wrote no files.
 * - `review-cap`: the configured number of completed reviews ran without an approval.
 * - `review-unavailable`: the session could not dispatch the Review subagent at all, so
 *   the runtime waived the requirement. This is never an approval.
 * - `skipped`: read from transcripts only. Finish used to let a second call skip the
 *   review; it no longer does, but persisted completions keep their recorded outcome.
 */
export type ReviewTermination = "approved" | "review-cap" | "review-unavailable" | "skipped"

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
  /**
   * A `finish` call was already declined for the current work. A decline is not a
   * waiver: the flag only lets the next decline say that retrying does not skip review.
   */
  readonly nudged: boolean
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
 * Reports delivered through the report envelope carry their assessment in the
 * machine-readable `<alphacode-review>` block, which is canonical. A detected
 * but invalid envelope — malformed content, truncated tags, or an unsupported
 * schema version — is a delivery failure: it never falls through to the prose
 * scan, or a broken report could mint a verdict the delivery layer already
 * rejected. Only output with no envelope at all (legacy transcripts) falls
 * back to a tolerant text scan: headings, emphasis, bullets, and the labels
 * "Assessment", "Verdict", and "Ready to proceed" are all accepted. A
 * positive-sounding paragraph without an explicit assessment is not an
 * approval.
 */
export function parseReviewVerdict(output: string): Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined {
  const delivery = ReviewReport.extract([output])
  if (delivery.ok) return delivery.report.assessment
  if (delivery.failure.reason !== "missing") return undefined

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

function taskTerminationReason(part: ReviewHistoryPart) {
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  const termination = isRecord(metadata?.termination) ? metadata.termination : undefined
  return typeof termination?.reason === "string" ? termination.reason : undefined
}

/**
 * A review task that delivered no verdict for this turn.
 *
 * A cancelled subagent delivered no review. The tool reports the cancellation as
 * a completed part carrying the typed reason, so without this the evaluator
 * counts a cancellation as a delivered review — and a few of them walk the turn
 * to the iteration cap and disable the review gate entirely.
 *
 * A yielded subagent (`waiting_for_subagent`) is the same kind of non-event,
 * for the opposite reason: it is still in flight through its own subagents, so
 * its report is provisional and its run ending now means nothing further will
 * be delivered for it. Counting it would let a review that keeps working after
 * its envelope - and whose final result is then dropped - satisfy the gate.
 *
 * That arm is now defensive: the finish tool refuses the yield for a session
 * that is itself a subagent, and the task envelope never carries the reason, so
 * only a transcript written before that guard reads as yielded. It stays
 * because the failure it prevents is silent.
 */
function isUnreportedReviewTask(part: ReviewHistoryPart) {
  if (!isSynchronousReviewTask(part)) return false
  if (part.state?.status === "cancelled") return true
  const reason = taskTerminationReason(part)
  return reason === "cancelled" || reason === "waiting_for_subagent"
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

function finishReviewMetadata(part: ReviewHistoryPart) {
  if (part.type !== "tool" || part.tool !== "finish") return undefined
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  return isRecord(metadata?.review) ? metadata.review : undefined
}

/**
 * The task tool attaches the delivered review report to the task result
 * metadata. Prefer it over the output text: a long review's output can be
 * truncated in the parent's history, which could cut the envelope or the
 * prose assessment while the report itself survives in metadata.
 */
function reviewReportVerdict(part: ReviewHistoryPart) {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  const metadata = isRecord(part.state?.metadata) ? part.state.metadata : undefined
  const review = isRecord(metadata?.review) ? metadata.review : undefined
  const report = isRecord(review?.report) ? review.report : undefined
  if (report?.version !== 1) return undefined
  return report.assessment === "approved" || report.assessment === "needs-fixes" ? report.assessment : undefined
}

function finishTermination(part: ReviewHistoryPart): ReviewTermination | undefined {
  if (part.state?.status !== "completed") return undefined
  const termination = finishReviewMetadata(part)?.termination
  if (
    termination === "approved" ||
    termination === "review-cap" ||
    termination === "review-unavailable" ||
    termination === "skipped"
  )
    return termination
  return undefined
}

function isFinishNudge(part: ReviewHistoryPart) {
  return part.state?.status === "error" && finishReviewMetadata(part)?.nudged === true
}

/**
 * Evaluate the current user turn. Synthetic continuation messages are deliberately
 * ignored as turn boundaries so a review/fix cycle cannot reset its counter.
 * Only completed tools whose persisted metadata explicitly declares `writesFiles`
 * count as work that requires review. The declaration lives on the tool definition,
 * so a new file-writing tool is classified where it is defined. Unmarked tools,
 * including shell, do not trigger the review gate.
 *
 * The gate is a requirement, not a nudge: a `finish` call declined for missing
 * review is remembered as `nudged` only so the next decline can say that a
 * retry does not skip review. New file writes or a new review reset it.
 */
export function reviewLoopState(messages: readonly ReviewHistoryMessage[], maxIterations = 5): ReviewLoopState {
  const max = Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : 1
  const start = messages.findLastIndex((message) => messageRole(message) === "user" && !isSyntheticUser(message))
  const current = start < 0 ? messages : messages.slice(start + 1)

  let reviews = 0
  let workSeen = false
  let workSinceReview = false
  let reviewInProgress = false
  let nudged = false
  let latest: Exclude<ReviewVerdict, "pending" | "none" | "cap"> | undefined
  let termination: ReviewTermination | undefined

  for (const part of current.flatMap((message) => message.parts)) {
    if (isReviewTask(part)) {
      if (!isSynchronousReviewTask(part)) continue
      // A cancelled or yielded review is a non-event: it never delivered a
      // verdict, so it neither counts toward the cap nor disturbs the verdict
      // already on record.
      if (isUnreportedReviewTask(part)) continue

      if (part.state?.status !== "completed") {
        latest = undefined
        workSinceReview = true
        reviewInProgress = part.state?.status === "pending" || part.state?.status === "running"
        nudged = false
        termination = undefined
        continue
      }

      reviews++
      latest =
        reviewReportVerdict(part) ?? parseReviewVerdict(typeof part.state.output === "string" ? part.state.output : "")
      workSinceReview = false
      reviewInProgress = false
      nudged = false
      termination = undefined
      continue
    }

    if (isFinishNudge(part)) {
      nudged = true
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
      nudged = false
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
    nudged,
    phase,
    ...(termination ? { termination } : {}),
  }
}

// The dispatch the model has to make, spelled the way the task tool takes it.
const REVIEW_DISPATCH =
  'call the `task` tool with `subagent_type: "review"` and `background: false`, and give it the request, the changed files, and the diff for this work'

/**
 * Decide whether this `finish` call is declined because the current work is
 * not approved.
 *
 * Every `finish` for unapproved file-writing work is declined, not only the
 * first one: a retry, or any account of the work in the finish result, cannot
 * stand in for a review. The requirement ends only on the evaluator's own
 * outcomes - an explicit approval, a turn without file writes, or the review
 * cap. The one waiver the runtime grants, a session that cannot dispatch the
 * Review subagent at all, needs the session to decide, so the finish tool
 * applies it and records it as `review-unavailable` rather than an approval.
 */
export function finishGateError(state: ReviewLoopState): Error | undefined {
  if (state.verdict !== "pending" && state.verdict !== "needs-fixes") return undefined
  const declined = state.nudged
    ? "Review required: finish declined again, because retrying finish does not skip review."
    : "Review required: finish declined."
  const status =
    state.verdict === "needs-fixes"
      ? "The latest report from the Review subagent returned Needs fixes, so the current work is not approved. Fix the findings, then run the Review subagent again:"
      : "The current work changed files and has no explicit Approved review from the Review subagent. Run the Review subagent now:"
  return new Error(
    `${declined} ${status} ${REVIEW_DISPATCH}. Call finish after it returns Approved; if it returns Needs fixes, fix the findings and review again. Calling finish again without that review is declined again, and calling the work creative, a prototype, trivial, or not production code does not exempt it.`,
  )
}
