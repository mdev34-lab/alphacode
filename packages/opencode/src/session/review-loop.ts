import {
  reviewLoopState as evaluateReviewLoop,
  type ReviewHistoryMessage,
  type ReviewLoopOptions,
} from "@opencode-ai/core/review-loop"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export {
  finishGateError,
  parseReviewVerdict,
  type ReviewLoopOptions,
  type ReviewLoopState,
  type ReviewPhase,
  type ReviewTermination,
  type ReviewVerdict,
} from "@opencode-ai/core/review-loop"

/**
 * Keep the V1 session shape at the opencode boundary while sharing the
 * evaluator with the TUI. The second argument stays number-compatible for
 * legacy callers; passing options switches the pass budget to the effort
 * policy, where the configured legacy `max_iterations` no longer applies.
 */
export function reviewLoopState(messages: readonly SessionV1.WithParts[], options: number | ReviewLoopOptions = 5) {
  return evaluateReviewLoop(messages as readonly ReviewHistoryMessage[], options)
}
