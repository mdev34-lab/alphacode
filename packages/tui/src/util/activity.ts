import type { AssistantMessage, Message, Part, ToolPart } from "@opencode-ai/sdk/v2"

const ACTIVITY_ID_PREFIX = "act-"

export type ActivityItem = {
  message: AssistantMessage
  part: ToolPart
}

export type ActivityGroup = {
  id: string
  items: ActivityItem[]
}

export type ActivityGroups = {
  byID: Map<string, ActivityGroup>
  groupOf: Map<string, string>
}

export type ActivityRow = {
  message: Message
  parts: readonly Part[]
}

// A group is a maximal run of consecutive tool parts in the conversation
// stream. Runs break at user messages and at assistant text/reasoning parts
// because those are the parts that render as visible conversation content;
// invisible parts (step-start/finish, snapshots, patches, ...) do not break a
// run. The group id is derived from the first part of the run so it stays
// stable while the run grows at its tail during streaming.
export function computeActivityGroups(rows: readonly ActivityRow[]): ActivityGroups {
  const byID = new Map<string, ActivityGroup>()
  const groupOf = new Map<string, string>()
  let current: ActivityGroup | undefined
  for (const row of rows) {
    if (row.message.role === "user") {
      current = undefined
      continue
    }
    for (const part of row.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        current = undefined
        continue
      }
      if (part.type !== "tool") continue
      if (!current) {
        current = { id: ACTIVITY_ID_PREFIX + part.id, items: [] }
        byID.set(current.id, current)
      }
      current.items.push({ message: row.message, part })
      groupOf.set(part.id, current.id)
    }
  }
  return { byID, groupOf }
}

export type ToolPartOutcome = "pending" | "running" | "completed" | "denied" | "interrupted" | "error"

// Denied and interrupted outcomes are tool errors that resulted from a user
// decision rather than from the tool itself. The inline tool rows render them
// as cancelled actions instead of failures, so group summaries need to tell
// them apart too.
export function toolPartOutcome(part: ToolPart): ToolPartOutcome {
  const state = part.state
  if (state.status !== "error") return state.status
  if (
    state.error.includes("QuestionRejectedError") ||
    state.error.includes("rejected permission") ||
    state.error.includes("specified a rule") ||
    state.error.includes("user dismissed")
  )
    return "denied"
  if (state.metadata?.interrupted === true || state.error.includes("Tool execution aborted")) return "interrupted"
  return "error"
}

export type ActivitySummary = {
  count: number
  working: boolean
  failed: number
  denied: boolean
  interrupted: boolean
  durationMs: number | undefined
}

export function summarizeActivity(parts: readonly ToolPart[]): ActivitySummary {
  let working = false
  let failed = 0
  let denied = false
  let interrupted = false
  let start: number | undefined
  let end: number | undefined
  for (const part of parts) {
    const outcome = toolPartOutcome(part)
    if (outcome === "pending" || outcome === "running") working = true
    if (outcome === "error") failed++
    if (outcome === "denied") denied = true
    if (outcome === "interrupted") interrupted = true
    const state = part.state
    if (state.status !== "pending" && state.time.start !== undefined) {
      start = start === undefined ? state.time.start : Math.min(start, state.time.start)
    }
    if (state.status === "completed" || state.status === "error") {
      end = end === undefined ? state.time.end : Math.max(end, state.time.end)
    }
  }
  const durationMs = working || start === undefined || end === undefined ? undefined : Math.max(0, end - start)
  return { count: parts.length, working, failed, denied, interrupted, durationMs }
}

export type ActivityHeader = {
  marker: "▸" | "▾"
  main: string
  failed: string | undefined
  note: string | undefined
}

export function activityHeader(
  summary: ActivitySummary,
  options: { expanded: boolean; duration: string | undefined },
): ActivityHeader {
  const marker = options.expanded ? "▾" : "▸"
  const calls = `${summary.count} tool call${summary.count === 1 ? "" : "s"}`
  const failed = summary.failed > 0 ? `${summary.failed} failed` : undefined
  if (summary.working) return { marker, main: `Working... ${calls}`, failed, note: undefined }
  const main = options.duration ? `Worked for ${options.duration} · ${calls}` : calls
  const note = summary.interrupted ? "interrupted" : summary.denied ? "denied" : undefined
  return { marker, main, failed, note }
}
