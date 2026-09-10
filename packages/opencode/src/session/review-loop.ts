export * as ReviewLoop from "./review-loop"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import NUDGE_TEMPLATE from "./prompt/review-loop-nudge.txt"

/**
 * Enforcement for the mandatory Work → Review loop (issue #90).
 *
 * The review policy text (session/prompt/review-loop.txt) tells the default
 * primary agent it must obtain a reviewer approval before claiming completion,
 * and must re-review after fixing findings. A model that ends the turn early —
 * because its own "done" signal fires on the work pass rather than on the
 * approval — used to get its way: the session loop exited on any completed
 * `finish` call. These helpers derive the loop's real state from the message
 * history of the current task and let the driver refuse that exit until review
 * approves.
 *
 * Termination design: review convergence is measured by progress, not by a
 * small cycle count. The loop keeps cycling work ↔ review for as long as each
 * pass changes what the reviewer blocks on — complex tasks are expected to
 * need many rounds — and releases early only when the reviewer repeats the
 * same blocking findings across consecutive passes (stalled: more cycles
 * would burn tokens without improving quality) or when the runaway cap is
 * reached. The cap is a safety bound for a genuinely stuck or pathological
 * session, not a quality bar.
 *
 * The state is a fold over the task's tool parts, so it survives nudges and is
 * replayable: no per-session mutable registry is needed.
 */

/** Marker prefix on the automated nudge so nudges never count as task starts. */
export const NUDGE_MARKER = "[REVIEW LOOP]"

/** Marker prefix on the transcript note written when the loop exits on the cap. */
export const CAP_MARKER = "[REVIEW LOOP CAP]"

/** Marker prefix on the transcript note written when the loop exits as stalled. */
export const STALL_MARKER = "[REVIEW LOOP STALL]"

/** Agent name of the reviewer whose verdict the loop waits for. */
export const REVIEW_SUBAGENT = "review"

/**
 * Runaway bound on review passes per task, for sessions that never converge
 * for reasons the stall guard cannot see (e.g. findings oscillate without
 * repeating). Deliberately generous — dozens of rounds of *productive* review
 * on a complex task is the intended behavior, not an error to release early.
 */
export const DEFAULT_MAX_ITERATIONS = 25

/**
 * Consecutive completed reviews reporting the identical blocking
 * (Critical/Important) findings before the loop releases as stalled. The
 * reviewer repeating itself across fix attempts means the work is not
 * converging; the model must then adjudicate the findings, not dispatch again.
 */
export const DEFAULT_STALL_LIMIT = 3

// Tools that mutate files in the working tree. bash is deliberately absent:
// the loop cannot reliably tell a `git commit` from unrelated output, and the
// policy treats commits as gated by the preceding approval.
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])

export type Verdict = "approved" | "needs-fixes" | "unknown"

/**
 * Reads the reviewer's assessment verdict. The review prompt requires every
 * report to end with `**Ready to proceed?** Approved | Needs fixes`; the loose
 * fallback below catches a reviewer that paraphrases the verdict while still
 * reporting findings. Anything unparseable counts as not approved so a
 * malformed report cannot silently clear the gate.
 */
export function parseVerdict(output: string): Verdict {
  const line = /ready to proceed\??[^A-Za-z]*(approved|needs[ -]fixes)/i.exec(output)
  if (line) return /^approved/i.test(line[1]) ? "approved" : "needs-fixes"
  if (/needs[ -]fixes/i.test(output)) return "needs-fixes"
  return "unknown"
}

/**
 * Normalized signature of the reviewer's blocking findings, used only to
 * detect stalls. Collects the bullet lines of the Critical and Important
 * sections and folds whitespace/case so reworded-but-identical findings still
 * compare equal per line. Returns undefined when the report carries neither
 * severity heading — a malformed report is never compared, so parsing noise
 * can never release a progressing loop.
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
      .join("\n")
  }
  return `${section("Critical")}\n${section("Important")}`.trim()
}

export interface State {
  /** A file-mutating tool call completed during this task. */
  filesChanged: boolean
  /** Review subagent dispatches started during this task (any status). */
  reviewPasses: number
  /** A review dispatch is still in flight. */
  reviewRunning: boolean
  /** The newest completed review returned an Approved verdict. */
  approved: boolean
  /** Unapproved changes since the last approval, or unresolved findings. */
  dirty: boolean
  lastVerdict: Verdict | undefined
  /** Findings signature of the latest unapproved completed review. */
  lastFindings: string | undefined
  /** Consecutive completed reviews repeating that exact signature. */
  stallStreak: number
}

/**
 * The current task's messages: everything after the last real user message.
 * Automated reminders (user messages whose text part is synthetic, such as
 * the finish nudge and this module's review nudges) do not open a new task and
 * never cut the slice — otherwise every nudge would reset the loop's memory.
 */
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

/** Folds one task's message parts into the review loop state. */
export function assess(messages: readonly SessionV1.WithParts[]): State {
  const state: State = {
    filesChanged: false,
    reviewPasses: 0,
    reviewRunning: false,
    approved: false,
    dirty: false,
    lastVerdict: undefined,
    lastFindings: undefined,
    stallStreak: 0,
  }
  for (const msg of taskSlice(messages)) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (MUTATING_TOOLS.has(part.tool)) {
        if (part.state.status === "completed") {
          state.filesChanged = true
          state.dirty = true
          state.approved = false
        }
        continue
      }
      if (part.tool !== "task") continue
      if (part.state.input?.subagent_type !== REVIEW_SUBAGENT) continue
      state.reviewPasses += 1
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
      } else {
        // Progress tracking for the stall guard: identical blocking findings
        // across consecutive passes mean the work is not converging. New or
        // different findings reset the streak, so productive iteration — even
        // many rounds long — is never punished.
        const findings = severityFindings(part.state.output)
        if (findings !== undefined && findings === state.lastFindings) {
          state.stallStreak += 1
        } else {
          state.lastFindings = findings
          state.stallStreak = findings === undefined ? 0 : 1
        }
      }
    }
  }
  return state
}

export interface Decision {
  /** The loop applies to this task: file changes await review or carry findings. */
  inLoop: boolean
  /** The task must not exit yet — inject the nudge and keep the loop running. */
  blocked: boolean
  /** The reviewer is repeating the same blocking findings; further cycles are not progress. */
  stalled: boolean
  /** Why the loop ended when exit was allowed: approval, the runaway cap, or a stall. */
  exitReason: "approved" | "cap" | "stalled" | undefined
  /** Review passes used so far, at least 1 while the loop is waiting. */
  iteration: number
  cap: number
  /** What the loop is waiting on right now. */
  phase: "work" | "review"
  state: State
}

/**
 * Decides the loop's reaction for one driver iteration.
 *
 * `nudges` is the number of review nudges already injected in the current
 * driver run. It lets the cap release the loop even when the model keeps
 * ending turns without dispatching any review at all — reviewPasses alone
 * would never reach the cap in that degenerate case. `stallLimit` overrides
 * the progress-based release threshold (see DEFAULT_STALL_LIMIT).
 */
export function decide(
  messages: readonly SessionV1.WithParts[],
  input: { cap: number; nudges: number; stallLimit?: number },
): Decision {
  const state = assess(messages)
  const inLoop = state.filesChanged && state.dirty
  const stalled = state.dirty && state.stallStreak >= (input.stallLimit ?? DEFAULT_STALL_LIMIT)
  const atCap = state.reviewPasses >= input.cap || input.nudges >= input.cap
  return {
    inLoop,
    stalled,
    blocked: inLoop && !stalled && !atCap,
    exitReason: state.filesChanged
      ? state.dirty
        ? stalled
          ? "stalled"
          : atCap
            ? "cap"
            : undefined
        : "approved"
      : undefined,
    iteration: Math.max(state.reviewPasses, input.nudges, inLoop ? 1 : 0),
    cap: input.cap,
    phase: state.reviewRunning ? "review" : "work",
    state,
  }
}

/* -------------------------------------------------------------------------
 * Loop display state (statusline)
 *
 * The session processor publishes `busy` at the start of every stream
 * attempt; while the review loop is enforcing an iteration, that set must
 * publish the loop instead, so the indicator survives across steps. The
 * runLoop refreshes this map at every iteration top, so a value read during
 * a turn is always derived from the same message fold that gated the turn.
 * ---------------------------------------------------------------------- */

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

/** The automated reminder injected when the loop blocks a task exit. */
export function nudgeText(decision: Decision): string {
  const pending =
    decision.state.reviewPasses === 0
      ? "No review has been dispatched for this change."
      : decision.state.lastVerdict === "needs-fixes"
        ? "The latest review reported Critical or Important findings that have not been addressed and re-reviewed yet."
        : "The latest review did not return an explicit Approved verdict, so the current changes are not cleared."
  return NUDGE_TEMPLATE.replace(/\{marker\}/g, NUDGE_MARKER)
    .replace(/\{iteration\}/g, String(decision.iteration))
    .replace(/\{cap\}/g, String(decision.cap))
    .replace(/\{pending\}/g, pending)
}

/** Transcript note recorded when the loop releases on the runaway cap. */
export function capNoteText(decision: Decision): string {
  const passes = String(decision.state.reviewPasses)
  return `${CAP_MARKER} Review loop ended on the iteration cap after ${passes} review pass(es) without an Approved verdict — this is NOT an approval. Unresolved findings must be adjudicated by the user.`
}

/** Transcript note recorded when the loop releases because review is not converging. */
export function stallNoteText(decision: Decision): string {
  const streak = String(decision.state.stallStreak)
  const passes = String(decision.state.reviewPasses)
  return `${STALL_MARKER} Review loop released after ${passes} review pass(es): the last ${streak} reviews reported the same unresolved findings, so further rounds were not making progress — this is NOT an approval. Each remaining finding must be adjudicated (fixed, or parked with written justification) for the user.`
}

/** Release note matching the decision's exit reason, if any. */
export function exitNoteText(decision: Decision): string | undefined {
  if (decision.exitReason === "cap") return capNoteText(decision)
  if (decision.exitReason === "stalled") return stallNoteText(decision)
  return undefined
}
