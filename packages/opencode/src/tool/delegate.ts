import * as Tool from "./tool"
import DESCRIPTION from "./delegate.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { CODE, WORK } from "@opencode-ai/core/agent-selection"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "../project/instance-context"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { deriveDelegationResult, type DelegationResult } from "./delegate-result"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PositiveInt } from "@opencode-ai/core/schema"
import { ToolFailure } from "@opencode-ai/llm"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { errorMessage } from "@/util/error"
import path from "path"

export interface Constraints {
  /**
   * The delegate may not modify state: every tool that declares the
   * `mutates` trait (file tools, shell, subagent tools) is denied, as are
   * all MCP tools, so the child cannot act directly or hand write access
   * to another session.
   */
  readOnly?: boolean
  /**
   * When true, the delegate may run `git commit`. Default is false. The
   * contract has three parts, and only the first is enforcement:
   *  1. The child's permission rules deny the known `git commit` forms up
   *     front, preventing the direct invocations.
   *  2. A before/after HEAD comparison is a post-hoc bypass *detector*, not
   *     enforcement: it catches commits the static patterns can't match (e.g.
   *     built via `eval`), after the side effect has already happened.
   *  3. When it fires, the delegation result is marked unverified in the
   *     warnings so the caller knows the commit ban was bypassed.
   */
  allowCommit?: boolean
}

export const Parameters = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      'Target agent for the delegation, e.g. "code" for software engineering inside a Git repository or "work" for general filesystem and document work.',
  }),
  task: Schema.String.annotate({
    description:
      "The task contract: what to accomplish, the acceptance criteria, and any constraints that do not fit the readOnly/allowCommit fields.",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description:
      "Working directory for the delegation, relative to or absolute inside the current workspace. Defaults to the workspace directory.",
  }),
  constraints: Schema.optional(
    Schema.Struct({
      readOnly: Schema.optional(Schema.Boolean).annotate({
        description:
          "If true, the delegate cannot modify files, run shell commands, launch subagents (task/delegate), or call MCP tools.",
      }),
      allowCommit: Schema.optional(Schema.Boolean).annotate({
        description:
          "If true, the delegate may run git commit. Default is false: the known git commit forms are denied up front by permission rules, and a before/after HEAD check reports any commit that bypassed them as an unverified result in the warnings.",
      }),
    }),
  ).annotate({ description: "Isolation constraints for the delegation." }),
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ).annotate({ description: "Model override for the delegate. Defaults to the target agent's model or the current model." }),
  timeoutMs: Schema.optional(PositiveInt).annotate({
    description: "Deadline in milliseconds. The delegation is cancelled and reported as timed out past it.",
  }),
})

const id = "delegate"

/** Marker returned by the deadline side of the timeout race. */
const TIMEOUT = Symbol("delegate-timeout")

function renderContract(input: { agent: string; task: string; cwd: string; constraints?: Constraints }): string {
  const constraintLines: string[] = []
  if (input.constraints?.readOnly === true)
    constraintLines.push(
      "- Read-only: do not create, modify, or delete files, do not run shell commands, and do not launch subagents or MCP tools.",
    )
  if (input.constraints?.allowCommit !== true) constraintLines.push("- Commits are forbidden: do not run `git commit`.")
  return [
    `You are the \`${input.agent}\` agent running as an isolated delegate of another agent.`,
    "The caller only sees the result you report: be complete about what was done and what was not.",
    "",
    "Task:",
    input.task,
    "",
    `Working directory: ${input.cwd}`,
    "Run file and shell operations in the working directory.",
    "",
    constraintLines.length > 0
      ? `Constraints:\n${constraintLines.join("\n")}`
      : "No additional constraints beyond your agent rules.",
    "",
    'When finished, call the `finish` tool with a single-line JSON object as its result argument:',
    '{"summary": "<one-paragraph outcome>", "warnings": ["<anything the caller should know>"]}',
  ].join("\n")
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text
  return text.slice(0, length - 1) + "…"
}

/**
 * Hard sandbox for read-only delegations. Denies every permission key for a
 * tool that declares the `mutates` trait, so the child cannot mutate state
 * directly or hand write access to another session via a subagent. The keys
 * come from tool definition metadata, not a hardcoded list here; a new
 * mutating tool is covered by declaring `mutates: true` on its definition.
 */
export function constraintRules(mutating: string[]): PermissionV1.Ruleset {
  return mutating.map((permission) => ({ permission, pattern: "*" as const, action: "deny" as const }))
}

/**
 * Hides every MCP tool from a read-only child. MCP tools are not covered by
 * the mutates-trait rules above but can still change state, so a read-only
 * contract has to exclude them too.
 */
export function mcpRules(tools: string[]): PermissionV1.Ruleset {
  return tools.map((permission) => ({ permission, pattern: "*" as const, action: "deny" as const }))
}

/**
 * Prevents known commit invocations in the child's ruleset — the preventive
 * half of the commit ban. Only `allowCommit: true` lifts these. The shell
 * permission matcher sees one pattern per command of the parsed shell line,
 * so the rules cover the direct form (`git commit`, `git commit ...`), git
 * with leading options (`git -C . commit`), and wrapped or env-prefixed
 * invocations (`sh -c "git commit"`, `sh -c "git -C . commit"`). Commands
 * that build the string dynamically (e.g. `eval`) are not matchable by any
 * static pattern; those are left to the post-hoc HEAD check, which detects
 * the bypass after the fact and marks the result unverified — it does not
 * prevent the commit.
 */
export function commitRules(constraints: Constraints | undefined): PermissionV1.Ruleset {
  if (constraints?.allowCommit === true) return []
  return [
    { permission: "bash", pattern: "git commit *", action: "deny" },
    { permission: "bash", pattern: "git * commit *", action: "deny" },
    { permission: "bash", pattern: "*git commit*", action: "deny" },
    { permission: "bash", pattern: "*git * commit*", action: "deny" },
  ]
}

/**
 * The Work/Code delegation relationship, enforced where delegation is
 * validated. Delegation crosses the Work/Code boundary — and only that
 * boundary. There are exactly two valid edges: Work → Code (code work) and
 * Code → Work (non-code work). Everything else is refused: delegating to
 * another primary agent (plan, a custom agent) would turn a boundary crossing
 * into generic primary-agent orchestration; a subagent (those run via the task
 * tool) and a hidden agent are not delegation targets either.
 *
 * This is the agent topology. It is deliberately independent of
 * `subagent_depth`, which is a generic nesting limit answering "how many
 * delegate levels may exist" and says nothing about which agents may delegate
 * to which. Returns an error message when the delegation is not allowed.
 */
export function delegationTargetError(from: string, target: Agent.Info): string | undefined {
  const crosses = (from === WORK && target.name === CODE) || (from === CODE && target.name === WORK)
  if (crosses) return undefined

  if (target.name === from) {
    return `Cannot delegate to the same agent ("${from}"). Delegation crosses the Work/Code boundary: from "work" delegate to "code", or from "code" delegate to "work".`
  }
  if (from !== WORK && from !== CODE) {
    return `Delegation crosses the Work/Code boundary, so it starts from "work" or "code"; the "${from}" agent cannot delegate.`
  }
  if (target.mode === "subagent") {
    return `Agent ${target.name} is a subagent and cannot be a delegation target; subagents run inside a turn via the task tool.`
  }
  if (target.hidden) {
    return `Agent ${target.name} is hidden and cannot be delegated to`
  }
  const expected = from === WORK ? CODE : WORK
  return `Delegation crosses the Work/Code boundary: from "${from}", delegate to "${expected}", not "${target.name}".`
}

/** Resolves the repository HEAD at `cwd`, or undefined when there is no repository. */
function gitHead(cwd: string): Effect.Effect<string | undefined> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" })
      const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      if (code !== 0) return undefined
      const head = text.trim()
      return head || undefined
    },
    catch: () => new Error("git rev-parse failed"),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

const COMMIT_VIOLATION =
  "allowCommit is false but the repository HEAD moved during the delegation - a commit may have bypassed the permission rules; treat the result as unverified"

export const DelegateTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const mcp = yield* MCP.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const fs = yield* FSUtil.Service

    const run = Effect.fn("DelegateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const instance = yield* InstanceState.context

      // Validate the deterministic inputs before asking for permission, so a
      // bad agent name or cwd fails fast instead of prompting the user first.
      const target = yield* agent.get(params.agent)
      if (!target) return yield* Effect.fail(new Error(`Unknown agent: ${params.agent} is not a valid agent`))

      // The Work/Code relationship: a delegation crosses the Work/Code
      // boundary (work → code, code → work) and nothing else. Independent of
      // nesting depth.
      const targetError = delegationTargetError(ctx.agent, target)
      if (targetError) return yield* Effect.fail(new Error(targetError))

      // Bounded nesting: a generic depth limit. A delegation counts as one
      // subagent level, so the same subagent_depth that bounds task tool
      // subagents bounds it here. It answers "how many delegate levels may
      // exist"; it does not encode which agents may delegate to which.
      let current = yield* sessions.get(ctx.sessionID)
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Delegation depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested delegations.`,
          ),
        )
      }

      const cwd = params.cwd ? path.resolve(instance.directory, params.cwd) : instance.directory
      if (!containsPath(cwd, instance)) {
        return yield* Effect.fail(new Error(`Delegation cwd must stay inside the current workspace: ${cwd}`))
      }
      if (!(yield* fs.isDir(cwd))) {
        return yield* Effect.fail(new Error(`Delegation cwd is not a directory: ${cwd}`))
      }

      // Remembering "always" for one agent must not silently authorize
      // delegating to every other agent.
      yield* ctx.ask({
        permission: id,
        patterns: [params.agent],
        always: [params.agent],
        metadata: {
          agent: params.agent,
          task: truncate(params.task, 120),
          cwd: params.cwd,
          constraints: params.constraints,
        },
      })

      const parent = yield* sessions.get(ctx.sessionID)
      const readOnly = params.constraints?.readOnly === true
      const mcpTools = readOnly ? Object.keys(yield* mcp.tools()) : []
      const mutating = Array.isArray(ctx.extra?.mutatingPermissionKeys)
        ? (ctx.extra.mutatingPermissionKeys as string[])
        : []
      const childPermission: PermissionV1.Ruleset = [
        ...deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: target }),
        ...(readOnly ? constraintRules(mutating) : []),
        ...commitRules(params.constraints),
        ...mcpRules(mcpTools),
      ]
      const child = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `Delegation (@${target.name}): ${truncate(params.task, 60)}`,
        agent: target.name,
        permission: childPermission,
      })

      // Baseline for the post-delegation commit check; skipped when commits
      // are explicitly allowed or the cwd is not a repository.
      const headBefore = commitRules(params.constraints).length > 0 ? yield* gitHead(cwd) : undefined

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const model = params.model ?? target.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }

      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("DelegateTool requires promptOps in ctx.extra"))

      yield* ctx.metadata({
        title: `Delegation (@${target.name}): ${truncate(params.task, 60)}`,
        metadata: { sessionId: child.id, agent: target.name, cwd },
      })

      const variant = target.model || params.model ? undefined : msg.info.variant
      const timeoutMs = params.timeoutMs
      const timeoutMessage = timeoutMs === undefined ? undefined : `Delegation timed out after ${timeoutMs} ms`
      const contract = renderContract({ agent: target.name, task: params.task, cwd, constraints: params.constraints })
      const childRun = Effect.fn("DelegateTool.childRun")(function* () {
        const parts = yield* ops.resolvePromptParts(contract)
        return yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant,
          agent: target.name,
          parts,
        })
      })

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(child.id)
      const onAbort = () => runCancel.fork(cancel)

      const finish = (status: DelegationResult["status"], failure?: string) =>
        Effect.gen(function* () {
          const messages = yield* sessions
            .messages({ sessionID: child.id })
            .pipe(Effect.catchCause(() => Effect.succeed([] as SessionV1.WithParts[])))
          const derived = deriveDelegationResult({ messages, status, failure, cwd })
          const headAfter = headBefore === undefined ? undefined : yield* gitHead(cwd)
          const commitBypassed = headBefore !== undefined && headAfter !== undefined && headAfter !== headBefore
          const result: DelegationResult = commitBypassed
            ? { ...derived, warnings: [...derived.warnings, COMMIT_VIOLATION].slice(0, 10) }
            : derived
          return {
            title: `Delegation (@${target.name}): ${truncate(params.task, 60)}`,
            metadata: {
              sessionId: child.id,
              agent: target.name,
              cwd,
              ...result,
            },
            output: JSON.stringify(result, null, 2),
          }
        })

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const runChild = childRun().pipe(Effect.onInterrupt(() => cancel))
            const deadline =
              timeoutMs === undefined ? undefined : Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(TIMEOUT))
            const exit = yield* (deadline ? Effect.raceFirst(runChild, deadline) : runChild).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              if (exit.value === TIMEOUT) return yield* finish("timeout", timeoutMessage)
              return yield* finish("completed")
            }
            if (Cause.hasInterrupts(exit.cause)) {
              const status: DelegationResult["status"] = ctx.abort.aborted ? "cancelled" : "timeout"
              return yield* finish(status, status === "timeout" ? timeoutMessage : undefined)
            }
            const failure = Cause.prettyErrors(exit.cause)
              .map((error) => error.message)
              .join("; ")
            return yield* finish("error", failure || "Delegation failed")
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* cancel.pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
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
      description: DESCRIPTION,
      parameters: Parameters,
      // The delegation gate surfaces every failure as a typed, recoverable
      // ToolFailure (model-visible) rather than a defect, matching the finish
      // gate's contract. Interruptions (user abort) are untouched and still
      // propagate as cancellations.
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.mapError((error) => new ToolFailure({ message: errorMessage(error) }))),
    }
  }),
  { mutates: true },
)

export * as Delegate from "./delegate"
