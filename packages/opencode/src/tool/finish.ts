import * as Tool from "./tool"
import { ToolFailure } from "@opencode-ai/llm"
import { ReviewReport } from "@opencode-ai/core/review-report"
import DESCRIPTION from "./finish.txt"
import { Effect, Option, Schema } from "effect"
import { Todo } from "../session/todo"
import { Session } from "../session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Config } from "@/config/config"
import { BackgroundJob } from "@/background/job"
import { finishGateError, reviewLoopState } from "../session/review-loop"
import { isReviewAgent } from "../agent/review-agents"

const DeclaredReasons = ["success", "waiting_for_subagent", "subagent_wait", "failure"] as const

export const Reason = Schema.Literals(DeclaredReasons)

export type Reason = Schema.Schema.Type<typeof Reason>

/**
 * The full termination contract for a finished run, as delivered to a parent
 * through a `<termination reason="...">` element.
 *
 * The model only ever declares {@link Reason} on the finish tool; `cancelled`
 * cannot be declared there. A cancelled subagent never reaches a finish call —
 * the user stops it mid-run — so the runtime records the cancellation itself
 * instead of forcing the reason through a tool input the model never supplied.
 */
export const TerminationReason = Schema.Literals([...DeclaredReasons, "cancelled"])

export type TerminationReason = Schema.Schema.Type<typeof TerminationReason>

export const Parameters = Schema.Struct({
  reason: Reason.annotate({
    description:
      "Why the agent is ending this turn: success when the task is complete, waiting_for_subagent when yielding the turn while background subagents you launched are still running (main session only — a subagent's run ends at its yield, so it must deliver its own result), subagent_wait when progress depends on a subagent that will not report back on its own, or failure when the task could not be completed.",
  }),
  result: Schema.String.annotate({
    description:
      "The final result of the task: a concise summary of what was accomplished, presented to the user as the task outcome.",
  }),
})

/**
 * Reads the termination reason the model declared on a completed finish call.
 *
 * Three cases, deliberately not collapsed into one default:
 *
 * - A record with no `reason` is a transcript written before the field existed.
 *   Those turns were successes, so absence reads as `success` and the loop
 *   still exits with a verdict.
 * - A record carrying a reason this build does not recognise is not a legacy
 *   transcript. It resolves to `undefined` rather than to `success`, so a
 *   future build's value is never silently upgraded into a delivered verdict by
 *   an older one.
 * - Anything that is not a record cannot be read at all and yields `undefined`.
 */
export function readTermination(part: SessionV1.ToolPart): Reason | undefined {
  if (part.tool !== FinishTool.id) return undefined
  if (part.state.status !== "completed") return undefined
  const input = part.state.input
  if (typeof input !== "object" || input === null) return undefined
  const declared = (input as { reason?: unknown }).reason
  if (declared === undefined) return "success"
  return Option.getOrUndefined(Schema.decodeUnknownOption(Reason)(declared))
}

export const FinishTool = Tool.define(
  "finish",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const background = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // A yield and a terminal result are two success shapes. Naming the fields
      // the tool can return keeps `metadata` checked for consumers instead of
      // widening it to the index signature, while still letting inference see a
      // single contract rather than collapsing both branches into one shape
      // whose every field is optional.
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<
        Tool.ExecuteResult<{
          waiting?: boolean
          termination?: { reason: Reason }
          review?: {
            verdict: string
            reviews: number
            maxIterations: number
            termination: string
          }
        }>,
        ToolFailure
      > =>
        Effect.gen(function* () {
          yield* ctx.waitForOtherTools ?? Effect.void
          const messages = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
          // The Review subagent completes its run through this same finish
          // tool, so the structured review result is gated here, at the
          // control-flow boundary: without a parseable report envelope the
          // call fails as recoverable model feedback and the run continues
          // instead of completing without a verdict.
          if (isReviewAgent(ctx.agent)) {
            const currentMessage = messages.find((message) => message.info.id === ctx.messageID)
            const delivery = ReviewReport.extract([
              ...(currentMessage?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
              params.result,
            ])
            if (!delivery.ok) {
              yield* Effect.logWarning("finish declined: review result missing or unparseable", {
                sessionID: ctx.sessionID,
                reason: delivery.failure.reason,
              })
              return yield* Effect.fail(
                new ToolFailure({
                  message: [
                    `Review finish rejected: ${delivery.failure.message}.`,
                    `The review run cannot complete until finish is called with a result containing a valid <${ReviewReport.TAG}> report envelope: {"version": 1, "revision": string, "assessment": "approved" | "needs-fixes", "summary": string, "findings": [{"severity": "critical" | "important" | "minor", "title": string}]}.`,
                    `Emit the envelope and call finish again; the review continues.`,
                  ].join(" "),
                }),
              )
            }
          }
          // Yielding for background work is not a termination. The turn ends so
          // the model stops polling for the subagents it launched, but the
          // session is woken by their notification, so a wait must leave
          // everything the real finish depends on untouched: the review nudge
          // (consumed once per unit of work), the plan, and the terminal
          // metadata the review loop reads as a delivered outcome.
          //
          if (params.reason === "waiting_for_subagent") {
            const jobs = yield* background.list()
            // A subagent cannot yield. `runTask` is a single prompt, so a
            // child's run ends at its yield and this provisional result would
            // be the parent's only delivery: the work the child waits on would
            // never reach it, and a child's job that has ended cannot be waited
            // on again. Only a session that is not itself a task can yield;
            // #222 tracks keeping a child's job alive so a nested yield works.
            const session = yield* sessions
              .get(ctx.sessionID)
              .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
            const isSubagentRun =
              session.parentID !== undefined ||
              jobs.some(
                (job) =>
                  job.type === "task" && job.status === "running" && BackgroundJob.runsSession(job, ctx.sessionID),
              )
            if (isSubagentRun) {
              yield* Effect.logWarning("finish declined: a subagent session cannot yield for its own subagents", {
                sessionID: ctx.sessionID,
              })
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Cannot wait: this session is itself a subagent, and a subagent's run ends at its yield — " +
                    "the parent would receive this provisional result as the run's only delivery, and whatever " +
                    "this session waits on would never reach it. " +
                    'Deliver your own result with reason: "success", or "failure" if the task could not be completed.',
                }),
              )
            }
            // The filter below is a snapshot, not a reservation (#222): a job
            // whose cancellation is already in flight still reads `running`
            // here, so a wait can be accepted whose child never notifies.
            // The same ownership relation the cancellation walks use, narrowed
            // to the jobs a wait can actually be woken by: a task this session
            // launched. A session's own run job is not work it can wait for.
            const running = jobs.filter(
              (job) =>
                job.type === "task" && job.status === "running" && BackgroundJob.isSubagentOf(job, ctx.sessionID),
            )
            if (running.length === 0) {
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Cannot wait: no running background subagents found for this session. " +
                    "Wait only for a task you launched that is still running — a subagent whose run " +
                    "already ended will not report again. " +
                    'If your work is complete, call finish with reason: "success".',
                }),
              )
            }
            yield* Effect.logInfo("finish yielded while background subagents run", {
              sessionID: ctx.sessionID,
              subagents: running.length,
            })
            return {
              title: `Waiting for ${running.length} background subagent(s)`,
              output: params.result,
              metadata: { waiting: true },
            }
          }

          const cfg = yield* config.get()
          const maxIterations = cfg.review_loop?.max_iterations ?? 5
          const reviewState = reviewLoopState(messages, maxIterations)
          const gateError = finishGateError(reviewState)
          if (gateError) {
            const phase = reviewState.workSinceReview
              ? "work"
              : reviewState.verdict === "needs-fixes"
                ? "work"
                : "review"
            yield* Effect.logWarning("finish declined with review nudge", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              phase,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
              workSinceReview: reviewState.workSinceReview,
            })
            // Persist the nudge on the failed part so the next finish call for the
            // same work is recognised as an explicit skip instead of being declined again.
            yield* ctx.metadata({
              title: "Review suggested",
              metadata: {
                review: {
                  nudged: true,
                  verdict: reviewState.verdict,
                  reviews: reviewState.reviews,
                  maxIterations: reviewState.maxIterations,
                },
              },
            })
            return yield* Effect.fail(new ToolFailure({ message: gateError.message }))
          }

          const skipped =
            reviewState.nudged && (reviewState.verdict === "pending" || reviewState.verdict === "needs-fixes")
          if (skipped) {
            yield* Effect.logWarning("review skipped by explicit finish", {
              sessionID: ctx.sessionID,
              verdict: reviewState.verdict,
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
            })
          }

          if (reviewState.verdict === "cap") {
            yield* Effect.logWarning("review loop terminated at cap", {
              sessionID: ctx.sessionID,
              phase: "review",
              reason: "review-cap",
              reviews: reviewState.reviews,
              maxIterations: reviewState.maxIterations,
            })
          }

          yield* Effect.gen(function* () {
            const existing = yield* todo.get(ctx.sessionID)
            const hasOpen = existing.some((t) => t.status === "pending" || t.status === "in_progress")
            if (!hasOpen) return
            const closed = existing.map((t) =>
              t.status === "pending" || t.status === "in_progress" ? { ...t, status: "cancelled" as const } : t,
            )
            yield* todo.update({ sessionID: ctx.sessionID, todos: closed })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("finish todo cleanup failed, but finish still succeeds", {
                sessionID: ctx.sessionID,
                cause,
              }),
            ),
          )

          return {
            title: "Task completed",
            output: params.result,
            metadata: {
              termination: { reason: params.reason },
              review: {
                verdict: reviewState.verdict,
                reviews: reviewState.reviews,
                maxIterations: reviewState.maxIterations,
                termination: skipped ? "skipped" : reviewState.verdict === "cap" ? "review-cap" : "approved",
              },
            },
          }
        }),
    }
  }),
)
