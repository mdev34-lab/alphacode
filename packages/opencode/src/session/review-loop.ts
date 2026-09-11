export * as ReviewLoop from "./review-loop"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import NUDGE_TEMPLATE from "./prompt/review-loop-nudge.txt"

export const NUDGE_MARKER = "[REVIEW LOOP]"
export const CAP_MARKER = "[REVIEW LOOP CAP]"
export const STALL_MARKER = "[REVIEW LOOP STALL]"
export const UNRESPONSIVE_MARKER = "[REVIEW LOOP UNRESPONSIVE]"
export const REVIEW_SUBAGENT = "review"
export const DEFAULT_STALL_LIMIT = 3
export const UNRESPONSIVE_NUDGE_LIMIT = 5

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])
const SHELL_TOOL = "bash"

/**
 * Shell commands are conservatively treated as mutating unless every command
 * in the compound expression is known to be read-only. This catches arbitrary
 * file writes such as `python -c`, `node -e`, `sed -i`, and redirections while
 * avoiding a review after ordinary inspection/test commands.
 */
const READ_ONLY_SHELL = /^(?:
  (?:env\s+)?(?:pwd|cd|pushd|popd|ls|dir|type|which|where|whoami|id|cat|head|tail|less|more|grep|rg|find|fd|awk|sort|uniq|wc|basename|dirname|realpath|readlink|printf|echo|true|false|test|command|uname|ver|where\.exe)\b|
  git\s+(?:status|diff|log|show|rev-parse|branch|tag|ls-files|check-ignore|describe|remote|config\s+--get(?:-all)?|symbolic-ref)\b|
  (?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|typecheck|check|format|fmt)|exec\s+(?:test|lint|typecheck|tsc)|--version|-v)\b|
  (?:node|deno|python|python3)\s+--version\b
)/ix

function shellSegments(command: string) {
  return command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function shellMayMutate(command: string): boolean {
  if (!command.trim()) return false
  if (/(^|[\s])(?:>|>>|<>)[\s]*/.test(command)) return true
  return shellSegments(command).some((segment) => !READ_ONLY_SHELL.test(segment))
}

function toolMutates(part: SessionV1.ToolPart): boolean {
  if (MUTATING_TOOLS.has(part.tool)) return true
  if (part.tool !== SHELL_TOOL) return false
  const command = part.state.input?.command
  return typeof command === "string" && shellMayMutate(command)
}

export type Verdict = "approved" | "needs-fixes" | "unknown"

/**
 * A review can clear the gate only when it contains the required assessment
 * verdict and explicit Critical/Important sections with no blocking bullets.
 * Missing or contradictory review structure is never treated as approval.
 */
export function parseVerdict(output: string): Verdict {
  const match = /ready to proceed\??[^A-Za-z]*(approved|needs[ -]fixes)/i.exec(output)
  if (!match) return /needs[ -]fixes/i.test(output) ? "needs-fixes" : "unknown"

  const verdict = /^approved$/i.test(match[1]) ? "approved" : "needs-fixes"
  if (verdict !== "approved") return verdict
  if (!/####\s*Critical[^\n]*\n/i.test(output)) return "unknown"
  if (!/####\s*Important[^\n]*\n/i.test(output)) return "unknown"

  const findings = severityFindings(output)
  return findings === "" ? "approved" : "unknown"
}

/**
 * Returns normalized Critical/Important bullet findings. `undefined` means the
 * report does not contain either required severity section. Zero-finding bullets
 * such as `None` are ignored so an explicit clean report can be approved.
 */
export function severityFindings(output: string): string | undefined {
  const hasCritical = /####\s*Critical/i.test(output)
  const hasImportant = /####\s*Important/i.test(output)
  if (!hasCritical && !hasImportant) return undefined

  const section = (title: string) => {
    const start = new RegExp(`####\\s*${title}[^\\n]*\\n`, "i").exec(output)
    if (!start) return ""
    const rest = output.slice(start.index + start[0].length)
    const next = /\n#{2,4}\s/.exec(rest)
    const body = next ? rest.slice(0, next.index) : rest
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+\S/.test(line))
      .map((line) =>
        line
          .replace(/^[-*]\s+/, "")
          .replace(/\s+/g, " ")
          .toLowerCase(),
      )
      .filter((line) => !/^(?:none|none found|no findings?|nothing to report)$/i.test(line))
      .join("\n")
  }

  return `${section("Critical")}\n${section("Important")}`.trim()
}

export interface State {
  filesChanged: boolean
  progressCount: number
  reviewPasses: number
  reviewRunning: boolean
  approved: boolean
  dirty: boolean
  lastVerdict: Verdict | undefined
  lastFindings: string | undefined
  stallStreak: number
  /** Consecutive review-loop nudges after which no file mutation or review dispatch occurred. */
  unresponsiveStreak: number
}

export function taskSlice(messages: readonly SessionV1.WithParts[]): readonly SessionV1.WithParts[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    const text = msg.parts.find((part): part is SessionV1.TextPart => part.type === "text")
    if (text && text.synthetic === true) continue
    return messages.slice(i + 1)
  }
  return messages
}

export function assess(messages: readonly SessionV1.WithParts[]): State {
  const state: State = {
    filesChanged: false,
    progressCount: 0,
    reviewPasses: 0,
    reviewRunning: false,
    approved: false,
    dirty: false,
    lastVerdict: undefined,
    lastFindings: undefined,
    stallStreak: 0,
    unresponsiveStreak: 0,
  }
  let progressSinceNudge = 0

  for (const msg of taskSlice(messages)) {
    if (msg.info.role === "user") {
      const reviewNudge = msg.parts.some(
        (part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true && part.text.startsWith(NUDGE_MARKER),
      )
      if (reviewNudge) {
        state.unresponsiveStreak = progressSinceNudge === 0 ? state.unresponsiveStreak + 1 : 0
        progressSinceNudge = 0
      }
    }

    for (const part of msg.parts) {
      if (part.type !== "tool") continue

      if (toolMutates(part) && part.state.status === "completed") {
        state.filesChanged = true
        state.progressCount += 1
        progressSinceNudge += 1
        state.unresponsiveStreak = 0
        state.dirty = true
        state.approved = false
        continue
      }

      if (part.tool !== "task" || part.state.input?.subagent_type !== REVIEW_SUBAGENT) continue

      state.reviewPasses += 1
      state.progressCount += 1
      progressSinceNudge += 1
      state.unresponsiveStreak = 0
      if (part.state.status === "pending" || part.state.status === "running") {
        state.reviewRunning = true
        continue
      }

      state.reviewRunning = false
      if (part.state.status === "error") {
        state.approved = false
        state.dirty = true
        state.lastVerdict = "unknown"
        continue
      }

      const verdict = parseVerdict(part.state.output)
      state.lastVerdict = verdict
      state.approved = verdict === "approved"
      state.dirty = verdict !== "approved"

      if (verdict === "approved") {
        state.lastFindings = undefined
        state.stallStreak = 0
        continue
      }

      const findings = severityFindings(part.state.output)
      if (findings !== undefined && findings === state.lastFindings) {
        state.stallStreak += 1
      } else {
        state.lastFindings = findings
        state.stallStreak = findings === undefined ? 0 : 1
      }
    }
  }

  return state
}

export interface Decision {
  inLoop: boolean
  blocked: boolean
  stalled: boolean
  exitReason: "approved" | "cap" | "stalled" | "unresponsive" | undefined
  iteration: number
  cap: number | undefined
  phase: "work" | "review"
  state: State
}

export function decide(
  messages: readonly SessionV1.WithParts[],
  input: { cap?: number; nudges: number; stallLimit?: number },
): Decision {
  const state = assess(messages)
  const inLoop = state.filesChanged && state.dirty
  const stalled = state.dirty && state.stallStreak >= (input.stallLimit ?? DEFAULT_STALL_LIMIT)
  const atCap = input.cap !== undefined && state.reviewPasses >= input.cap
  const unresponsive = state.dirty && state.unresponsiveStreak >= UNRESPONSIVE_NUDGE_LIMIT

  return {
    inLoop,
    stalled,
    blocked: inLoop && !stalled && !atCap && !unresponsive,
    exitReason: !state.filesChanged
      ? undefined
      : !state.dirty
        ? "approved"
        : stalled
          ? "stalled"
          : atCap
            ? "cap"
            : unresponsive
              ? "unresponsive"
              : undefined,
    iteration: Math.max(state.reviewPasses, input.nudges, inLoop ? 1 : 0),
    cap: input.cap,
    phase: state.reviewRunning ? "review" : "work",
    state,
  }
}

export interface Display {
  readonly iteration: number
  readonly cap: number
  readonly phase: "work" | "review"
}

const displays = new Map<string, Display>()

export function setDisplay(sessionID: string, display: Display) {
  displays.set(sessionID, display)
}

export function clearDisplay(sessionID: string) {
  displays.delete(sessionID)
}

export function displayFor(sessionID: string): Display | undefined {
  return displays.get(sessionID)
}

export function nudgeText(decision: Decision): string {
  const pending =
    decision.state.reviewPasses === 0
      ? "No review has been dispatched for this change."
      : decision.state.lastVerdict === "needs-fixes"
        ? "The latest review reported blocking findings that have not been addressed and re-reviewed yet."
        : "The latest review did not return an explicit Approved verdict, so the current changes are not cleared."
  const progress =
    decision.cap === undefined
      ? `${decision.iteration} review pass(es) so far; the loop has no round limit`
      : `${decision.iteration} with ${decision.state.reviewPasses} review pass(es) used of the ${decision.cap}-pass cap`
  const release = ["consecutive reviews repeat your unresolved findings (the loop is stalled)"]
  if (decision.cap !== undefined) release.push(`the configured cap of ${decision.cap} review passes is reached`)
  release.push("you stop making progress and ignore these reminders")
  return NUDGE_TEMPLATE.replace(/\{marker\}/g, NUDGE_MARKER)
    .replace(/\{progress\}/g, progress)
    .replace(/\{pending\}/g, pending)
    .replace(/\{release\}/g, `after ${release.join(" or ")}`)
}

export function capNoteText(decision: Decision): string {
  const passes = String(decision.state.reviewPasses)
  return `${CAP_MARKER} Review loop ended on the configured review-pass cap after ${passes} review pass(es) without an Approved verdict — this is NOT an approval. Unresolved findings must be adjudicated by the user.`
}

export function stallNoteText(decision: Decision): string {
  const streak = String(decision.state.stallStreak)
  const passes = String(decision.state.reviewPasses)
  return `${STALL_MARKER} Review loop released after ${passes} review pass(es): the last ${streak} reviews reported the same unresolved findings, so further rounds were not making progress — this is NOT an approval. Each remaining finding must be adjudicated (fixed, or parked with written justification) for the user.`
}

export function unresponsiveNoteText(decision: Decision): string {
  const iterations = String(decision.iteration)
  return `${UNRESPONSIVE_MARKER} Review loop released after ${iterations} unresponsive iterations: the model produced no additional file mutation or review dispatch between reminders — this is NOT an approval. The work is delivered without review approval; findings, if any, must be adjudicated by the user.`
}

export function exitNoteText(decision: Decision): string | undefined {
  if (decision.exitReason === "cap") return capNoteText(decision)
  if (decision.exitReason === "stalled") return stallNoteText(decision)
  if (decision.exitReason === "unresponsive") return unresponsiveNoteText(decision)
  return undefined
}
