export type BackgroundResultState = "completed" | "error"

export type BackgroundResult = {
  state: BackgroundResultState
  summary: string
}

const TASK_OPEN = /<task\b[^>]*>/
const TASK_STATE = /\bstate="(completed|error)"/
const TASK_SUMMARY = /<summary>([\s\S]*?)<\/summary>/

// A background subagent result reaches the parent session as a synthetic text
// part carrying the task tool's delivery markup (`<task id state>` with a
// `<summary>`). Recognizing that persisted shape — rather than the raw text —
// is what keeps the history indicator attached to real transcript state.
export function parseBackgroundResult(text: string): BackgroundResult | undefined {
  const open = text.match(TASK_OPEN)?.[0]
  if (!open) return undefined
  const state = open.match(TASK_STATE)?.[1]
  if (state !== "completed" && state !== "error") return undefined
  const summary = text.match(TASK_SUMMARY)?.[1]?.trim()
  if (!summary) return undefined
  return { state, summary }
}
