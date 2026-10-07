import * as Tool from "./tool"
import { FinishTool, readTermination, type TerminationReason } from "@/tool/finish"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { isReviewAgent, resolveReviewer } from "../agent/review-agents"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Ref, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Subagents run asynchronously by default: the tool launches the subagent and returns immediately.",
  "You will be notified automatically when it finishes; do not sleep, poll, or ask it for status.",
  "Use background=false for synchronous execution only when you need the result before continuing.",
].join(" ")
// The yield instruction is scoped to a parent that has not finished: delivering
// a completed result while a task keeps running is still the normal ending, and
// this task's notification wakes the session when its run ends. It is also
// limited to the main session, because the wait is refused for a session that is
// itself a subagent: a child's run ends at its yield, so a yield from a child
// would deliver a provisional result and nothing else.
const BACKGROUND_STARTED = [
  "The task is running in the background. You will be notified automatically when its run ends.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  'Work on non-overlapping tasks. If your own task is complete, call finish with reason "success" as usual: a task still running in the background does not hold your result back.',
  'If it is not finished and you have no independent work left, the main session can call finish with reason "waiting_for_subagent" to yield — this task\'s notification wakes it. A subagent cannot yield this way: its run ends at the yield, so it must deliver with "success" or "failure" instead.',
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when its run ends.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  'Work on non-overlapping tasks. If your own task is complete, call finish with reason "success" as usual: a task still running in the background does not hold your result back.',
  'If it is not finished and you have no independent work left, the main session can call finish with reason "waiting_for_subagent" to yield — this task\'s notification wakes it. A subagent cannot yield this way: its run ends at the yield, so it must deliver with "success" or "failure" instead.',
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent asynchronously (default: true). The tool returns immediately and you are notified when it completes. DO NOT sleep, poll, or proactively check on its progress. Set to false to run synchronously and wait for the result.",
  }),
})

/**
 * Wording for the termination element the parent reads out of the envelope.
 *
 * A subagent that ends on `subagent_wait` is parked on a dependency, not slow
 * and not in flight. Say so in the parent envelope so the parent never reads a
 * waiting run as a fire-and-forget task it should wait on. `success` carries no
 * note: the reason is the signal, and the result text already says the work is
 * done.
 *
 * `waiting_for_subagent` is defensive. The finish tool refuses a wait from a
 * session that is itself a subagent, so a task child should never reach this
 * entry; it is kept for a transcript or a path that predates that guard (#222
 * makes a nested yield real). If one arrives, the honest reading is the one the
 * note gives: the yield ended the child's run, so no report follows this one.
 */
const TERMINATION_NOTE: Record<TerminationReason, string> = {
  success: "",
  subagent_wait: "Subagent stopped on a dependency and is not in flight; it will not report back on its own.",
  waiting_for_subagent:
    "Subagent yielded its turn while the background subagents it launched are still running; its run ends there, so no later report follows this one.",
  failure: "Subagent stopped because the task could not be completed.",
  cancelled: "Subagent stopped because the user cancelled it; it did not complete and its result was not delivered.",
}

/**
 * Stand-in result for a cancelled run. A cancelled child never reaches a finish
 * call, so there is usually no output at all; the envelope must still say what
 * became of the task instead of delivering an empty result.
 */
const CANCELLED_TEXT = "The subagent was cancelled by the user before it delivered a result."

/**
 * Renders the parent-facing `<task>` envelope. The termination reason is part of
 * the envelope, not of the injected text, so a background notification and a
 * foreground tool result carry byte-identical termination for the same run.
 */
function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error" | "cancelled"
  summary?: string
  text: string
  termination?: TerminationReason
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    ...(input.termination
      ? [`<termination reason="${input.termination}">${TERMINATION_NOTE[input.termination]}</termination>`]
      : []),
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      // Background is the default. Only an explicit `background: false`
      // (synchronous request) waits for the child result before returning.
      const runInBackground = params.background !== false

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // The agent that owns this session, read from the session itself.
      //
      // A session row's `agent` is null for the default session, so the newest
      // user message is the fallback that actually names the running agent.
      // `MessageV2.page` returns messages oldest-first, hence `findLast`: the
      // agent currently driving the session is the last one to name itself, and
      // `find` would return a session's first-ever user message instead - which
      // inverts the routing in exactly the mid-session agent switch it exists to
      // handle. `ctx.agent` is deliberately not a tier here: on the subtask path
      // it is the CHILD's agent, so it would select a reviewer by the child's
      // identity. Hydration is deferred into the fallback so a pinned session
      // never pays for it.
      //
      // A parent that cannot be read fails the dispatch instead of resolving to
      // nothing. Swallowing the read made an unreadable parent degrade to the
      // generic reviewer, which then ran the wrong prompt under the wrong
      // permissions with nothing to indicate the routing had never happened -
      // and `ctx.agent` is no fallback, because it names the child. Only
      // `NotFound` is narrowed here; any other cause stays a defect rather than
      // being reinterpreted as "no parent agent", which is the only reading
      // this function can act on.
      const resolveParentAgent = Effect.fnUntraced(function* (session: Session.Info) {
        if (session.agent) return session.agent
        const messages = yield* sessions
          .messages({ sessionID: session.id, limit: 50 })
          .pipe(
            Effect.catchIf(NotFoundError.isInstance, (cause) =>
              Effect.fail(
                new Error(
                  `Cannot resolve which reviewer to dispatch: parent session ${session.id} could not be read (${cause.message})`,
                ),
              ),
            ),
          )
        return messages.findLast((message) => message.info.role === "user")?.info.agent
      })

      // One resolution, two consumers: routing the review request, and
      // addressing the background notification back to the parent. Resolving
      // twice could disagree - the pinned row and the newest user message are
      // read at two different moments, and a parent that switched agent
      // mid-thread is exactly the case this routing exists to handle - and a
      // notification delivered under an agent other than the one that
      // dispatched the task lands in a session that never asked for it. Cached
      // rather than hoisted so a task that neither routes a review nor delivers
      // a background result still never pays for the message read.
      // `Effect.cached` yields the memoized effect rather than its value, so nothing runs here.
      // Only the `review` routing below and the background delivery yield it.
      const parentAgentOf = yield* Effect.cached(resolveParentAgent(parent))

      // `review` is the request, not the identity. The parent agent decides
      // which reviewer actually runs, so the report gate, the permission prompt
      // and the delivered envelope all agree on one resolved name. Parents with
      // no specialization (plan, general, explore) keep the generic reviewer.
      // Yielding the read unconditionally would make every delegation pay for it
      // and hard-fail on an unreadable parent, not just a review.
      const routedParent = params.subagent_type === "review" ? yield* parentAgentOf : undefined
      const subagentType = resolveReviewer(params.subagent_type, routedParent)

      const next = yield* agent.get(subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagentType} is not a valid agent type`))
      }
      // Primary agents are session entry points, never delegation targets.
      // Reject them before permission prompts so an impossible delegation
      // cannot block on user interaction.
      if (next.mode === "primary") {
        return yield* Effect.fail(new Error(`Agent type ${subagentType} is a primary agent and cannot be delegated to`))
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          // Keyed on both names when routing rewrote the request. The requested
          // name is the user-facing contract - stored always-allow grants and
          // user config rules (`permission.task.review`) are written against it,
          // so re-keying on the routing decision alone would silently re-prompt
          // returning users and silently drop their `deny` rule. The resolved
          // name is added because a rule written against `work-review` or
          // `code-review` is just as legitimate, and because the metadata below
          // records the resolved name: a prompt gated on one name while its
          // stored input and every audit log report the other is a rule that
          // cannot be seen to have applied. Asking under both names is the
          // union, so no rule that could reasonably have gated this call is
          // skipped, and the common case - a request routing did not rewrite -
          // still prompts under exactly one name.
          patterns:
            subagentType === params.subagent_type ? [params.subagent_type] : [params.subagent_type, subagentType],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: subagentType,
          },
        })
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      // The child declares why it stopped on the finish tool input. Capture it
      // once, where the reply is already in hand, so the background and the
      // foreground delivery paths below report the same value without either
      // one re-reading the child transcript. A cancelled run never made a
      // finish call; that path records `cancelled` itself, so this ref holds the
      // whole termination contract rather than only the declared subset.
      const termination = yield* Ref.make<TerminationReason | undefined>(undefined)

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })

        const finish = result.parts.findLast(
          (item): item is SessionV1.ToolPart =>
            item.type === "tool" && item.tool === FinishTool.id && item.state.status === "completed",
        )
        yield* Ref.set(termination, finish ? readTermination(finish) : undefined)

        // The review subagent delivers its canonical result through a tagged
        // report envelope. Extract it from the complete child output — every
        // text part plus the finish summary — because the last text part alone
        // is not a reliable delivery boundary: a trailing empty text part can
        // erase an earlier report, and a missing or malformed envelope must
        // surface as an explicit delivery failure, never as an empty result.
        if (isReviewAgent(next.name)) {
          // A review run only completes through a successful finish call: the
          // finish tool itself rejects results without a parseable report, so
          // reaching this point without a completed finish means the run
          // terminated another way and must not silently become a verdict.
          if (!finish) {
            const analysis = result.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim()
            return yield* Effect.fail(
              new Error(
                ReviewReport.failureMessage({
                  sessionID: nextSession.id,
                  failure: { reason: "missing", message: "the review run ended without a completed finish call" },
                  analysis: analysis.length > 0 ? analysis : undefined,
                }),
              ),
            )
          }
          const summary = finish.state.input.result
          const delivery = ReviewReport.extract([
            ...result.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
            typeof summary === "string" ? summary : undefined,
          ])
          if (!delivery.ok)
            return yield* Effect.fail(
              new Error(
                ReviewReport.failureMessage({
                  sessionID: nextSession.id,
                  failure: delivery.failure,
                  analysis: delivery.analysis,
                }),
              ),
            )
          return ReviewReport.render(delivery)
        }

        const text = result.parts.findLast((item) => item.type === "text")?.text
        if (text !== undefined) return text
        // Subagents end their turn with the finish tool; its result argument is
        // the task summary.
        const summary = finish?.state.status === "completed" ? finish.state.input.result : undefined
        return typeof summary === "string" ? summary : ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error" | "cancelled",
        text: string,
        termination: TerminationReason | undefined,
      ) {
        // Notifications must run in the parent session, under the parent agent -
        // the same one the routing above read, not a second opinion taken when
        // the child finishes. `ctx.agent` is not a candidate: on the subtask path
        // it is the child's agent.
        const parentAgent = yield* parentAgentOf
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: parentAgent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : state === "cancelled"
                        ? `Background task cancelled: ${params.description}`
                        : `Background task failed: ${params.description}`,
                  text,
                  termination,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const reason = yield* Ref.get(termination)
              if (result.info?.status === "completed")
                return yield* inject("completed", result.info.output ?? "", reason)
              // A subagent can declare a reason and still fail afterwards, for
              // example when review envelope extraction fails after finish. The
              // reason was captured before that failure, so deliver it rather
              // than reporting a bare <task_error> with no signal.
              if (result.info?.status === "error") return yield* inject("error", result.info.error ?? "", reason)
              // A cancelled run produced no finish call and no declared reason.
              // The job outcome is the termination: deliver it so the parent
              // resumes orchestration knowing the user stopped the child,
              // instead of never hearing about a subagent that vanished.
              //
              // A cancel that cascaded from an ancestor's teardown is the
              // exception: cancelling a session (Ctrl+C, or its own double-Esc)
              // sweeps up every job beneath it, so delivering those would prompt
              // the session that is stopping and undo the interrupt. Only a
              // cancellation aimed at this job's own session is reported.
              if (result.info?.status === "cancelled") {
                if (result.info.cancelledByTeardown) return
                return yield* inject("cancelled", result.info.output ?? CANCELLED_TEXT, "cancelled")
              }
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            // Cancellation is a delivery, not a tool failure: the parent is
            // blocked on this call, and a free-form failure would leave it
            // re-deriving what happened from prose. The same envelope the
            // background path injects carries the typed reason here.
            if (result?.status === "cancelled")
              return {
                title: params.description,
                metadata: {
                  ...metadata,
                  termination: { reason: "cancelled" },
                },
                output: renderOutput({
                  sessionID: nextSession.id,
                  state: "cancelled",
                  text: result.output ?? CANCELLED_TEXT,
                  termination: "cancelled",
                }),
              } satisfies Tool.ExecuteResult
            // Re-associate the delivered review report with the result metadata
            // so consumers know which revision was reviewed without re-parsing
            // the output. The output already carries the canonical envelope.
            const review = isReviewAgent(next.name) ? ReviewReport.extract([result?.output ?? ""]) : undefined
            const reason = yield* Ref.get(termination)
            const completed: Tool.ExecuteResult = {
              title: params.description,
              metadata: {
                ...metadata,
                ...(review?.ok
                  ? { review: { report: review.report, sessionId: nextSession.id, revision: review.report.revision } }
                  : {}),
                ...(reason !== undefined ? { termination: { reason } } : {}),
              },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? "",
                termination: reason,
              }),
            }
            return completed
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
