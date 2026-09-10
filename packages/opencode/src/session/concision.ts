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
// Case-insensitive. Standalone tokens only — preceded by line start or
// whitespace and followed by whitespace or end — so pasted markdown links
// (`[long](…)`) or code (`arr[long]`) never trigger an override.
const TOKEN_PATTERN = /(^|\s)\[(long|brief)\](?=\s|$)/gi

export function parseTurnOverride(text: string): TurnOverride | undefined {
  let override: TurnOverride | undefined
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[2]?.toLowerCase()
    if (token === "long" || token === "brief") override = token
  }
  return override
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

// The word cap is shared across every text part of one assistant message,
// so a part can never sidestep the policy by arriving after a tool call.
// Paragraphs stay per-part. When the remaining budget is under the 2-word
// marker reserve, a further part collapses to just the marker (at most 2
// words of overage, once).
export function remainingCaps(caps: Caps, spentWords: number): Caps {
  return { maxWords: Math.max(0, caps.maxWords - spentWords), maxParagraphs: caps.maxParagraphs }
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

export type Segment = {
  type: "prose" | "fence"
  text: string
}

// Split into prose and fenced-code segments. A fence opens at a line whose
// first non-blank characters are ``` or ~~~ and closes at the next line
// starting with the same marker; an unclosed fence runs to the end and is
// treated as code (never truncated). Inline backticks mid-line do not open
// a fence.
export function splitSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let buffer: string[] = []
  let kind: "prose" | "fence" = "prose"
  let marker: string | undefined
  const flush = () => {
    if (buffer.length) segments.push({ type: kind, text: buffer.join("\n") })
    buffer = []
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart()
    const fence = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : undefined
    if (kind === "prose" && fence) {
      flush()
      kind = "fence"
      marker = fence
    } else if (kind === "fence" && fence && marker && fence.startsWith(marker)) {
      buffer.push(line)
      flush()
      kind = "prose"
      marker = undefined
      continue
    }
    buffer.push(line)
  }
  flush()
  return segments
}

const untouched = (text: string) => ({ text, truncated: false, omittedWords: 0, omittedParagraphs: 0 })

// Hard floor: cut anything past the cap and mark it. The marker is part of
// the word budget so the result always fits the cap.
//
// Fenced code is a deliverable, not chat prose: fence blocks always pass
// through intact and do not count against the cap — the cap applies to the
// prose around them. (Exempting the whole reply because it contains a fence
// would let verbose prose ride along under a one-line snippet.)
export function enforce(text: string, resolved: Resolved): Enforced {
  const caps = resolved.caps
  if (!caps) return untouched(text)
  const cleaned = stripFiller(text)
  const segments = splitSegments(cleaned)
  const fenced = segments.some((s) => s.type === "fence")

  const prose = fenced
    ? segments
        .filter((s) => s.type === "prose")
        .map((s) => s.text)
        .join("\n\n")
    : cleaned
  const paragraphs = splitParagraphs(prose)
  const totalWords = countWords(prose)
  if (paragraphs.length <= caps.maxParagraphs && totalWords <= caps.maxWords) return untouched(cleaned)

  if (!fenced) {
    const keptParagraphs = paragraphs.slice(0, caps.maxParagraphs)
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
      omittedParagraphs: Math.max(0, paragraphs.length - keptParagraphs.length),
    }
  }

  // Fenced reply: keep every fence block in place; drop prose paragraphs
  // (whole paragraphs, in order) once the prose budget is spent. Dropped
  // prose later in the reply may leave later code blocks without their
  // intro — acceptable: deliverables stay complete, prose stays capped.
  const out: string[] = []
  // Reserve 2 words for the inline marker, as in the plain-prose path, so
  // the reply minus its code blocks always fits the cap.
  let wordsLeft = caps.maxWords - 2
  let paragraphsLeft = caps.maxParagraphs
  let keptWords = 0
  let keptParagraphs = 0
  let truncated = false
  for (const seg of segments) {
    if (seg.type === "fence") {
      out.push(seg.text)
      continue
    }
    for (const para of splitParagraphs(seg.text)) {
      const words = countWords(para)
      if (words === 0) continue
      if (paragraphsLeft <= 0 || wordsLeft <= 0) {
        truncated = true
        continue
      }
      const take = Math.min(words, wordsLeft)
      if (take < words) truncated = true
      out.push(para.trim().split(/\s+/).slice(0, take).join(" "))
      keptWords += take
      keptParagraphs += 1
      wordsLeft -= take
      paragraphsLeft -= 1
    }
  }
  const omittedWords = Math.max(0, totalWords - keptWords)
  if (!truncated) return untouched(cleaned)
  const body = out.filter((part) => part !== "").join("\n\n")
  return {
    text: body === "" ? `… [+${omittedWords}]` : `${body}\n\n… [+${omittedWords}]`,
    truncated: true,
    omittedWords,
    omittedParagraphs: Math.max(0, paragraphs.length - keptParagraphs),
  }
}

export * as Concision from "./concision"
