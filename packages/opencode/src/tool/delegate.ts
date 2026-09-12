import * as Tool from "./tool"
import DESCRIPTION from "./delegate.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "../project/instance-context"
import { parsePatch } from "../patch"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"

export interface Constraints {
  /**
   * The delegate may not modify files: no file tools, no shell, and no
   * subagent (task/delegate) or MCP tools, so it cannot cause side effects
   * out of band either.
   */
  readOnly?: boolean
  /**
   * When true, the delegate may run `git commit`. Default is false: commit
   * commands are denied by permission rules and any HEAD change is reported
   * in the result warnings as a possible rule bypass.
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
          "If true, the delegate may run git commit. Default is false: commits are denied and any repository HEAD change is reported in the result warnings.",
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

export interface TestOutcome {
  command: string
  status: "passed" | "failed"
  exitCode: number | null
}

/** Machine-readable result of one delegation, returned to the calling agent. */
export interface DelegationResult {
  status: "completed" | "error" | "timeout" | "cancelled"
  summary: string
  changedFiles: string[]
  tests: TestOutcome[]
  warnings: string[]
}

const id = "delegate"

/** Marker returned by the deadline side of the timeout race. */
const TIMEOUT = Symbol("delegate-timeout")

const TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b/

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

/**
 * Derives the machine-readable delegation result from the child session's
 * transcript. Changed files and test outcomes are observed facts from the
 * child's tool calls, not self-reports; the summary and extra warnings come
 * from the child's `finish` result when it is valid JSON. Relative tool
 * paths are resolved against the child's working directory, not the
 * process cwd.
 */
export function deriveDelegationResult(input: {
  messages: SessionV1.WithParts[]
  status: DelegationResult["status"]
  failure?: string
  cwd: string
}): DelegationResult {
  const changedFiles: string[] = []
  const tests: TestOutcome[] = []
  const warnings: string[] = []
  let summary = ""
  let reportedWarnings: string[] = []

  const addFile = (file: string | undefined) => {
    if (!file) return
    const resolved = path.isAbsolute(file) ? file : path.resolve(input.cwd, file)
    if (!changedFiles.includes(resolved)) changedFiles.push(resolved)
  }

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
        warnings.push(`${part.tool} failed: ${part.state.error.slice(0, 160)}`)
        continue
      }
      if (part.state.status !== "completed") continue
      const callInput = part.state.input
      if (part.tool === "write" || part.tool === "edit") addFile(callInput.filePath as string | undefined)
      if (part.tool === "apply_patch" && typeof callInput.patchText === "string") {
        for (const hunk of parsePatch(callInput.patchText).hunks) {
          addFile(hunk.path)
          if (hunk.type === "update") addFile(hunk.move_path)
        }
      }
      if (part.tool === "bash" && typeof callInput.command === "string" && TEST_COMMAND.test(callInput.command)) {
        const exitCode = typeof part.state.metadata?.exit === "number" ? part.state.metadata.exit : null
        tests.push({
          command: callInput.command,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
        })
      }
      if (part.tool === "finish" && typeof callInput.result === "string") {
        const reported = parseFinishResult(callInput.result)
        summary = reported.summary
        reportedWarnings = reported.warnings
      }
    }
  }

  warnings.push(...reportedWarnings)
  if (input.failure) warnings.push(input.failure.slice(0, 300))
  if (!summary) summary = input.status === "completed" ? "Delegation finished without a final report." : (input.failure ?? "")

  return {
    status: input.status,
    summary,
    changedFiles,
    tests,
    warnings: warnings.slice(0, 10),
  }
}

function parseFinishResult(text: string): { summary: string; warnings: string[] } {
  try {
    const value = JSON.parse(text) as { summary?: unknown; warnings?: unknown }
    const summary = typeof value.summary === "string" ? value.summary : ""
    const warnings = Array.isArray(value.warnings) ? value.warnings.filter((w): w is string => typeof w === "string") : []
    if (!summary && warnings.length === 0) throw new Error("empty")
    return { summary, warnings }
  } catch {
    return { summary: text, warnings: [] }
  }
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text
  return text.slice(0, length - 1) + "…"
}

/**
 * Hard sandbox for read-only delegations: no file mutation, no shell, and
 * no subagent tools, so the child cannot hand write access to another
 * session to get around its own ruleset.
 */
function constraintRules(constraints: Constraints | undefined): PermissionV1.Ruleset {
  if (constraints?.readOnly !== true) return []
  return (["bash", "edit", "write", "apply_patch", "task", "delegate"] as const).map((permission) => ({
    permission,
    pattern: "*" as const,
    action: "deny" as const,
  }))
}

/**
 * Hides every MCP tool from a read-only child. MCP tools are not covered by
 * the file/shell rules above but can still change state, so a read-only
 * contract has to exclude them too.
 */
export function mcpRules(tools: string[]): PermissionV1.Ruleset {
  return tools.map((permission) => ({ permission, pattern: "*" as const, action: "deny" as const }))
}

/**
 * Prohibits commits in the child's ruleset. Commits are denied by default;
 * only `allowCommit: true` lifts the restriction. The shell permission
 * matcher sees one pattern per command of the parsed shell line, so the
 * rules cover the direct form (`git commit`, `git commit ...`), git with
 * leading options (`git -C . commit`), and wrapped or env-prefixed
 * invocations (`sh -c "git commit"`). Commands that build the string
 * dynamically (e.g. `eval`) are not matchable by any pattern; the
 * post-delegation HEAD check reports those as violations instead.
 */
export function commitRules(constraints: Constraints | undefined): PermissionV1.Ruleset {
  if (constraints?.allowCommit === true) return []
  return [
    { permission: "bash", pattern: "git commit *", action: "deny" },
    { permission: "bash", pattern: "git * commit *", action: "deny" },
    { permission: "bash", pattern: "*git commit*", action: "deny" },
  ]
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

      // Bounded nesting: a delegation counts as one subagent level, so the
      // same subagent_depth that bounds task tool subagents bounds it here.
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

      if (params.agent === ctx.agent) {
        return yield* Effect.fail(
          new Error(`Cannot delegate to the same agent ("${params.agent}"). Delegate to a different agent such as "code" or "work".`),
        )
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

      const target = yield* agent.get(params.agent)
      if (!target) return yield* Effect.fail(new Error(`Unknown agent: ${params.agent} is not a valid agent`))
      if (target.hidden) return yield* Effect.fail(new Error(`Agent ${params.agent} is hidden and cannot be delegated to`))

      const cwd = params.cwd ? path.resolve(instance.directory, params.cwd) : instance.directory
      if (!containsPath(cwd, instance)) {
        return yield* Effect.fail(new Error(`Delegation cwd must stay inside the current workspace: ${cwd}`))
      }
      if (!(yield* fs.isDir(cwd))) {
        return yield* Effect.fail(new Error(`Delegation cwd is not a directory: ${cwd}`))
      }

      const parent = yield* sessions.get(ctx.sessionID)
      const readOnly = params.constraints?.readOnly === true
      const mcpTools = readOnly ? Object.keys(yield* mcp.tools()) : []
      const childPermission: PermissionV1.Ruleset = [
        ...deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: target }),
        ...constraintRules(params.constraints),
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
        Effect.orDie,
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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export * as Delegate from "./delegate"
