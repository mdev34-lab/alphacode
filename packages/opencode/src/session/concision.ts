// Strict output message concision policy (issue #91).
//
// Two layers, per the issue: a system-prompt rule that tells the model the
// cap, plus a client-side backstop in SessionProcessor that truncates any
// assistant text part past the cap. The backstop is the hard floor — the
// model reverts to verbosity under context pressure, so the prompt alone
// is not enforcement.
//
// Resolution precedence (highest first):
//   1. per-turn override token in the latest user message: [long] / [brief]
//   2. per-session flag: session metadata `concision`
//   3. global/project config `concision`
//   4. default: strict
//
// The override tokens stay in the message history so the lift is visible.

export type Mode = "strict" | "normal" | "off"
export type TurnOverride = "long" | "brief"

export const DEFAULT_MODE: Mode = "strict"

export const STRICT_MAX_WORDS = 80
export const STRICT_MAX_PARAGRAPHS = 2
export const NORMAL_MAX_WORDS = 200
export const NORMAL_MAX_PARAGRAPHS = 5
export const BRIEF_MAX_WORDS = 40
export const BRIEF_MAX_PARAGRAPHS = 1

export const LONG_TOKEN = "[long]"
export const BRIEF_TOKEN = "[brief]"

const MODES: Mode[] = ["strict", "normal", "off"]

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as string[]).includes(value)
}

export function normalizeMode(value: unknown): Mode {
  return isMode(value) ? value : DEFAULT_MODE
}

// Last token in the text wins, so a user can correct themselves mid-message.
// Case-insensitive; matches anywhere in the line, not only standalone.
export function parseTurnOverride(text: string): TurnOverride | undefined {
  const lower = text.toLowerCase()
  const longAt = lower.lastIndexOf(LONG_TOKEN)
  const briefAt = lower.lastIndexOf(BRIEF_TOKEN)
  if (longAt === -1 && briefAt === -1) return undefined
  return longAt >= briefAt ? "long" : "brief"
}

// Minimal structural shape of SessionV1.WithParts, so this module stays
// dependency-free. Each new user message starts a task, so only the
// latest real user message carries a per-turn override — synthetic
// messages (finish nudges, summaries) are skipped, never inherited from,
// and older tasks never leak their override into newer ones.
export type HistoryMessage = {
  readonly info: { readonly role: string }
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: unknown; readonly synthetic?: boolean }>
}

export function turnOverrideFromHistory(messages: HistoryMessage[]): TurnOverride | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    const text = msg.parts
      .filter((p) => p.type === "text" && p.synthetic !== true && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    if (text.trim() === "") continue
    return parseTurnOverride(text)
  }
  return undefined
}

export type Caps = {
  maxWords: number
  maxParagraphs: number
}

export type Resolved = {
  // Effective base mode (before the turn override is applied).
  mode: Mode
  // Turn override that was in effect, if any.
  override?: TurnOverride
  // True when no cap applies this turn ([long] or mode off).
  lifted: boolean
  // The cap to enforce, or undefined when lifted.
  caps?: Caps
  // Short human-readable label for the TUI footer / logs, e.g. "strict · ≤80w/2p".
  label: string
}

export function capsFor(mode: Mode, override?: TurnOverride): Caps | undefined {
  if (override === "long" || mode === "off") return undefined
  if (override === "brief") return { maxWords: BRIEF_MAX_WORDS, maxParagraphs: BRIEF_MAX_PARAGRAPHS }
  if (mode === "normal") return { maxWords: NORMAL_MAX_WORDS, maxParagraphs: NORMAL_MAX_PARAGRAPHS }
  return { maxWords: STRICT_MAX_WORDS, maxParagraphs: STRICT_MAX_PARAGRAPHS }
}

export function resolve(input: { config?: unknown; session?: unknown; override?: TurnOverride }): Resolved {
  const mode = isMode(input.session) ? input.session : normalizeMode(input.config)
  const caps = capsFor(mode, input.override)
  const lifted = caps === undefined
  const label = lifted
    ? input.override === "long"
      ? `${mode} · long (lifted)`
      : "off"
    : input.override === "brief"
      ? `${mode} · brief · ≤${caps.maxWords}w/${caps.maxParagraphs}p`
      : `${mode} · ≤${caps.maxWords}w/${caps.maxParagraphs}p`
  return { mode, override: input.override, lifted, caps, label }
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return text.trim() === "" ? 0 : words.length
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

// Leading filler openers that must never start a reply. Only the leading
// sentence is inspected, and only exact opener matches are stripped.
const FILLER_OPENERS = [
  "sure!",
  "of course!",
  "great question!",
  "absolutely!",
  "certainly!",
  "happy to help!",
  "good question!",
  "great point!",
]

export function stripFiller(text: string): string {
  const next = text.trimStart()
  const lower = next.toLowerCase()
  for (const opener of FILLER_OPENERS) {
    if (!lower.startsWith(opener)) continue
    const after = next.slice(opener.length)
    // Only strip when the opener is its own phrase, not a prefix of a
    // longer word (e.g. "Surely this…" must survive).
    if (after !== "" && !/^[\s,;:!?—–-]/.test(after)) continue
    const rest = after.replace(/^[,;:!?—–-]\s*/, "").trimStart()
    return rest === "" ? next : rest
  }
  return text
}

export type Enforced = {
  text: string
  truncated: boolean
  omittedWords: number
  omittedParagraphs: number
}

// Hard floor: cut anything past the cap and mark it. The marker is part of
// the word budget so the result always fits the cap. Replies containing
// fenced code are deliverables, not chat prose — truncation would corrupt
// them, so they pass through (filler is still stripped).
export function enforce(text: string, resolved: Resolved): Enforced {
  const caps = resolved.caps
  if (!caps) return { text, truncated: false, omittedWords: 0, omittedParagraphs: 0 }
  const cleaned = stripFiller(text)
  if (/```|~~~/.test(cleaned)) {
    return { text: cleaned, truncated: false, omittedWords: 0, omittedParagraphs: 0 }
  }

  const paragraphs = splitParagraphs(cleaned)
  const totalWords = countWords(cleaned)
  if (paragraphs.length <= caps.maxParagraphs && totalWords <= caps.maxWords) {
    return { text: cleaned, truncated: false, omittedWords: 0, omittedParagraphs: 0 }
  }

  const keptParagraphs = paragraphs.slice(0, caps.maxParagraphs)
  const omittedParagraphs = Math.max(0, paragraphs.length - keptParagraphs.length)
  let body = keptParagraphs.join("\n\n")
  let words = body.trim().split(/\s+/).filter(Boolean)
  // Reserve 2 words for the inline marker so the total stays within budget.
  if (words.length > caps.maxWords - 2) {
    words = words.slice(0, Math.max(0, caps.maxWords - 2))
    body = words.join(" ")
  }
  const keptWords = countWords(body)
  const omittedWords = Math.max(0, totalWords - keptWords)
  return {
    text: body === "" ? `… [+${omittedWords}]` : `${body} … [+${omittedWords}]`,
    truncated: true,
    omittedWords,
    omittedParagraphs,
  }
}

export * as Concision from "./concision"
