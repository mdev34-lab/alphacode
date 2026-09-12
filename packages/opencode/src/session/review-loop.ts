import { reviewLoopState as evaluateReviewLoop, type ReviewHistoryMessage } from "@opencode-ai/core/review-loop"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export {
  finishGateError,
  parseReviewVerdict,
  type ReviewLoopState,
  type ReviewPhase,
  type ReviewTermination,
  type ReviewVerdict,
} from "@opencode-ai/core/review-loop"

/** Keep the V1 session shape at the opencode boundary while sharing the evaluator with the TUI. */
export function reviewLoopState(messages: readonly SessionV1.WithParts[], maxIterations = 5) {
  return evaluateReviewLoop(messages as readonly ReviewHistoryMessage[], maxIterations)
}
