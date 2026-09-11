/**
 * Streaming tool-call parser.
 *
 * Qwen Web has no native tool API, so tools are offered through prompt
 * instructions and the model emits JSON blocks wrapped in marker tags
 * (see `constants.ts`). This parser incrementally extracts those blocks from
 * streamed text while passing ordinary text through untouched.
 *
 * Accepted shapes inside a block:
 * - `{"name": "...", "arguments": {...}}`
 * - `{"function": {"name": "...", "arguments": {...}}}`
 * - `<name ...>` open tag attribute with a JSON body
 *
 * `arguments` may be an object or a JSON-encoded string. Malformed blocks are
 * recovered on a best-effort basis; unrecoverable ones are preserved as text
 * so no model output is ever silently dropped.
 */
import {
  QWEN_WEB_TOOL_CLOSE,
  QWEN_WEB_TOOL_CLOSE_NAMES,
  QWEN_WEB_TOOL_OPEN,
  QWEN_WEB_TOOL_OPEN_NAMES,
} from "./constants"
import { randomId } from "./protocol"

export interface ParsedToolCall {
  id: string
  name: string
  /** Stringified JSON arguments. */
  input: string
}

export interface ToolParserResult {
  /** Ordinary text with tool blocks removed. */
  text: string
  /** Tool calls completed by this push. */
  toolCalls: ParsedToolCall[]
}

export interface ToolParserOptions {
  /** Max tool calls accepted per parser lifetime (turn). Default 32. */
  maxToolCalls?: number
  /** Declared tool names; unknown names are still parsed (the AI SDK repairs them). */
  declared?: Set<string>
}

const MAX_TOOL_CALLS_DEFAULT = 32

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function openTagPattern(names: readonly string[]): RegExp {
  return new RegExp(`<(${names.map(escapeRegExp).join("|")})\\b[^>]*>`, "i")
}

function findOpen(buffer: string): { index: number; length: number; tag: string; nameAttr?: string } | null {
  const pattern = openTagPattern(QWEN_WEB_TOOL_OPEN_NAMES)
  const match = pattern.exec(buffer)
  if (!match || match.index === undefined) return null
  const tag = match[0]
  const nameAttr = /name\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
  return { index: match.index, length: tag.length, tag, nameAttr }
}

function matchCloseAt(buffer: string, index: number): number | null {
  for (const name of QWEN_WEB_TOOL_CLOSE_NAMES) {
    const prefix = `</${name}`
    if (buffer.length < index + prefix.length) continue
    if (buffer.slice(index, index + prefix.length).toLowerCase() !== prefix) continue
    let end = index + prefix.length
    while (end < buffer.length && /\s/.test(buffer[end]!)) end++
    if (buffer[end] === ">") return end + 1 - index
  }
  return null
}

function findClose(buffer: string, from: number): { index: number; length: number } | null {
  let cursor = from
  while (cursor < buffer.length) {
    const next = buffer.indexOf("<", cursor)
    if (next === -1) return null
    const length = matchCloseAt(buffer, next)
    if (length !== null) return { index: next, length }
    cursor = next + 1
  }
  return null
}

/** Length of a trailing partial open/close tag prefix that must be held back. */
function trailingPartialTagLength(buffer: string): number {
  const tail = buffer.slice(-24)
  const candidates = [
    ...QWEN_WEB_TOOL_OPEN_NAMES.map((name) => `<${name}`),
    ...QWEN_WEB_TOOL_CLOSE_NAMES.map((name) => `</${name}`),
  ]
  let best = 0
  for (let length = 1; length <= tail.length; length++) {
    const suffix = tail.slice(-length)
    if (candidates.some((candidate) => candidate.toLowerCase().startsWith(suffix.toLowerCase()))) best = length
  }
  return best
}

const ANY_STRAY_CLOSE_PATTERN = new RegExp(
  `\\s*<\\/(?:${QWEN_WEB_TOOL_CLOSE_NAMES.map(escapeRegExp).join("|")})\\s*>`,
  "ig",
)

function stripStrayCloses(value: string): string {
  return value.replace(ANY_STRAY_CLOSE_PATTERN, "")
}

/**
 * Recover a tool call whose opening tag the model omitted: a JSON tool-call
 * object followed by a stray close tag (observed when batch emissions degrade
 * mid-turn). Returns the text prefix, the parsed call, and the offset past the
 * close tag so the caller can slice the block out of the buffer.
 */
function tryOpenlessBlock(
  buffer: string,
  declared?: Set<string>,
): { prefix: string; call: ParsedToolCall; closeEnd: number } | undefined {
  const close = findClose(buffer, 0)
  if (!close) return undefined
  const text = buffer.slice(0, close.index)
  // Walk `{` candidates outermost-first: arguments may contain a nested
  // `"name"` key (e.g. a filename), and an innermost-first walk would
  // fabricate a call from that nested object and leak the outer JSON as text.
  const starts: number[] = []
  for (let index = text.indexOf("{"); index !== -1; index = text.indexOf("{", index + 1)) starts.push(index)
  for (const jsonStart of starts) {
    const call = toToolCall(repairJsonPayload(text.slice(jsonStart)), undefined, declared)
    if (call) return { prefix: text.slice(0, jsonStart), call, closeEnd: close.index + close.length }
  }
  return undefined
}

/** Best-effort JSON recovery: fences, trailing commas, truncation. */
export function repairJsonPayload(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const direct = tryParse(trimmed)
  if (direct !== undefined) return direct

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (unfenced !== trimmed) {
    const parsed = tryParse(unfenced)
    if (parsed !== undefined) return parsed
  }

  const noTrailingCommas = unfenced.replace(/,(\s*[}\]])/g, "$1")
  if (noTrailingCommas !== unfenced) {
    const parsed = tryParse(noTrailingCommas)
    if (parsed !== undefined) return parsed
  }

  const balanced = extractBalancedObject(unfenced)
  if (balanced !== undefined) {
    const parsed = tryParse(balanced)
    if (parsed !== undefined) return parsed
  }

  const completed = completeTruncatedJson(unfenced)
  if (completed !== undefined) {
    const parsed = tryParse(completed)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Extract the first balanced `{...}` object from the text. */
function extractBalancedObject(value: string): string | undefined {
  const start = value.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index++) {
    const char = value[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  return undefined
}

/** Close unterminated strings/objects/arrays for truncated payloads. */
function completeTruncatedJson(value: string): string | undefined {
  const start = value.indexOf("{")
  if (start === -1) return undefined
  let result = value.slice(start)
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const char of result) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") stack.push("}")
    else if (char === "[") stack.push("]")
    else if (char === "}" || char === "]") stack.pop()
  }
  if (inString) result += '"'
  const closeStack = (text: string): string => {
    let out = text
    const remaining = [...stack]
    while (remaining.length > 0) out += remaining.pop()
    return out
  }
  // A truncated string value usually just needs its closing quote.
  const closed = closeStack(result)
  if (tryParse(closed) !== undefined) return closed
  // Otherwise drop a dangling partial token (trailing `,`, or an incomplete
  // `"key` with no value yet) and close what remains.
  const stripped = result
    .replace(/,\s*$/, "")
    .replace(/"[^"]*$/, (match) => (match.includes(":") ? match : ""))
    .replace(/,\s*"[^":,]*$/, "")
  return closeStack(stripped)
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    const parsed = tryParse(value)
    return JSON.stringify(parsed === undefined ? { _raw: value } : parsed)
  }
  if (value && typeof value === "object") return JSON.stringify(value)
  return JSON.stringify(value ?? {})
}

/** Interpret a parsed block payload as a tool call, if possible. */
function toToolCall(
  payload: unknown,
  nameAttr: string | undefined,
  declared?: Set<string>,
): ParsedToolCall | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const fn = record["function"]
  const fnRecord = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : undefined
  const nameRaw = fnRecord?.["name"] ?? record["name"]
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : nameAttr?.trim()
  if (!name) return undefined
  if (declared && declared.size > 0 && !declared.has(name)) {
    // Still accept: the AI SDK repair hook converts unknown tools into a
    // visible `invalid` tool error instead of dropping the call silently.
  }
  const args = fnRecord?.["arguments"] ?? record["arguments"] ?? record["args"] ?? record["parameters"] ?? {}
  const idRaw = record["id"]
  return {
    id: typeof idRaw === "string" && idRaw ? idRaw : `call_${randomId()}`,
    name,
    input: normalizeArguments(args),
  }
}

export class StreamingToolParser {
  private buffer = ""
  private calls = 0
  private readonly maxCalls: number
  private readonly declared?: Set<string>
  private capped = false

  constructor(options?: ToolParserOptions) {
    this.maxCalls = options?.maxToolCalls ?? MAX_TOOL_CALLS_DEFAULT
    this.declared = options?.declared
  }

  get toolCallCount(): number {
    return this.calls
  }

  get isCapped(): boolean {
    return this.capped
  }

  push(chunk: string): ToolParserResult {
    this.buffer += chunk
    const toolCalls: ParsedToolCall[] = []
    let text = ""

    for (;;) {
      const open = findOpen(this.buffer)
      if (!open) {
        // The model sometimes drops the opening tag on a batch of calls
        // (degenerate multi-call output). If a stray close tag follows a
        // tool-call JSON object, reconstruct the block instead of pasting it.
        const repaired = tryOpenlessBlock(this.buffer, this.declared)
        if (repaired && !this.capped) {
          if (stripStrayCloses(repaired.prefix).trim().length > 0) text += stripStrayCloses(repaired.prefix)
          this.buffer = this.buffer.slice(repaired.closeEnd)
          this.calls++
          if (this.calls > this.maxCalls) this.capped = true
          else toolCalls.push(repaired.call)
          continue
        }
        break
      }
      // The prefix before the first open tag may itself hold degenerate
      // openless blocks (a batch whose later blocks kept their tags while an
      // earlier one lost its open tag). Drain those first so they are not
      // emitted as text.
      const openAt = open.index
      let prefix = this.buffer.slice(0, openAt)
      for (;;) {
        const repaired = tryOpenlessBlock(prefix, this.declared)
        if (!repaired || this.capped) break
        const cleaned = stripStrayCloses(repaired.prefix)
        if (cleaned.trim().length > 0) text += cleaned
        prefix = prefix.slice(repaired.closeEnd)
        this.calls++
        if (this.calls > this.maxCalls) this.capped = true
        else toolCalls.push(repaired.call)
      }
      if (prefix.length !== openAt) {
        this.buffer = prefix + this.buffer.slice(openAt)
        continue
      }
      // Emit text preceding the block, holding back a partial tag at the end.
      text += stripStrayCloses(this.buffer.slice(0, open.index))
      const afterOpen = open.index + open.length
      const close = findClose(this.buffer, afterOpen)
      if (!close) {
        // Incomplete block: keep everything from the open tag buffered.
        this.buffer = this.buffer.slice(open.index)
        return { text, toolCalls }
      }
      const raw = this.buffer.slice(afterOpen, close.index)
      this.buffer = this.buffer.slice(close.index + close.length)
      const call = toToolCall(repairJsonPayload(stripStrayCloses(raw)), open.nameAttr, this.declared)
      if (call && !this.capped) {
        this.calls++
        if (this.calls > this.maxCalls) {
          this.capped = true
        } else {
          toolCalls.push(call)
        }
      } else if (!call) {
        // Unparseable: preserve the content as text rather than dropping it.
        text += raw.trim() ? `${raw.trim()}\n` : ""
      }
      // `text` keeps accumulating; loop to find further blocks.
    }

    // No (more) open tags: emit everything except a trailing partial tag and a
    // trailing line that may yet become a tool-call JSON (its close tag can
    // arrive in the next chunk and is unrecoverable once the text is emitted).
    const holdBack = trailingPartialTagLength(this.buffer)
    if (holdBack > 0) {
      const head = this.buffer.slice(0, this.buffer.length - holdBack)
      const partial = this.buffer.slice(this.buffer.length - holdBack)
      // A partial close tag may complete in the next chunk; the JSON line
      // before it is unrecoverable once emitted, so hold it back as well.
      const content = head.endsWith("\n") ? head.slice(0, -1) : head
      const contentLf = content.lastIndexOf("\n")
      const candidate = contentLf === -1 ? content : content.slice(contentLf + 1)
      if (candidate.length > 0 && /^[ \t]*[\[{]/.test(candidate)) {
        const holdFrom = content.length - candidate.length
        text += stripStrayCloses(head.slice(0, holdFrom))
        this.buffer = head.slice(holdFrom) + partial
      } else {
        text += stripStrayCloses(head)
        this.buffer = partial
      }
    } else {
      const lastLf = this.buffer.lastIndexOf("\n")
      const lineStart = lastLf === this.buffer.length - 1 ? this.buffer.lastIndexOf("\n", lastLf - 1) : lastLf
      const tail = lineStart === -1 ? this.buffer : this.buffer.slice(lineStart + 1)
      if (tail.length > 0 && /^[ \t]*[\[{]/.test(tail)) {
        text += stripStrayCloses(this.buffer.slice(0, this.buffer.length - tail.length))
        this.buffer = tail
      } else {
        text += stripStrayCloses(this.buffer)
        this.buffer = ""
      }
    }
    return { text, toolCalls }
  }

  /** End of stream: recover an unclosed block, then emit leftovers as text. */
  flush(): ToolParserResult {
    const toolCalls: ParsedToolCall[] = []
    let text = ""

    // Drain degenerate openless blocks first (close tag with no open tag).
    for (;;) {
      if (findOpen(this.buffer) || this.capped) break
      const repaired = tryOpenlessBlock(this.buffer, this.declared)
      if (!repaired) break
      if (stripStrayCloses(repaired.prefix).trim().length > 0) text += stripStrayCloses(repaired.prefix)
      this.buffer = this.buffer.slice(repaired.closeEnd)
      this.calls++
      if (this.calls > this.maxCalls) this.capped = true
      else toolCalls.push(repaired.call)
    }

    let open = findOpen(this.buffer)
    if (open && !this.capped) {
      // Drain degenerate openless blocks from the text preceding the open tag
      // (same as push: they must not be emitted as text).
      const openAt = open.index
      let prefix = this.buffer.slice(0, openAt)
      for (;;) {
        const repaired = tryOpenlessBlock(prefix, this.declared)
        if (!repaired || this.capped) break
        const cleaned = stripStrayCloses(repaired.prefix)
        if (cleaned.trim().length > 0) text += cleaned
        prefix = prefix.slice(repaired.closeEnd)
        this.calls++
        if (this.calls > this.maxCalls) this.capped = true
        else toolCalls.push(repaired.call)
      }
      if (prefix.length !== openAt) {
        this.buffer = prefix + this.buffer.slice(openAt)
        open = findOpen(this.buffer)
      }
    }
    if (open && !this.capped) {
      const raw = stripStrayCloses(this.buffer.slice(open.index + open.length))
        .replace(/<\/?(?:qw_call|tool_calls?)\b[^>]*$/i, "")
        .trim()
      text += stripStrayCloses(this.buffer.slice(0, open.index))
      const call = raw ? toToolCall(repairJsonPayload(raw), open.nameAttr, this.declared) : undefined
      if (call) {
        this.calls++
        if (this.calls <= this.maxCalls) toolCalls.push(call)
        else this.capped = true
      } else if (raw) {
        text += raw
      }
    } else {
      text += stripStrayCloses(this.buffer)
    }
    this.buffer = ""
    return { text, toolCalls }
  }
}

/** Convenience: parse a complete (non-streamed) response. */
export function parseCompleteResponse(text: string, options?: ToolParserOptions): ToolParserResult {
  const parser = new StreamingToolParser(options)
  const first = parser.push(text)
  const last = parser.flush()
  return { text: first.text + last.text, toolCalls: [...first.toolCalls, ...last.toolCalls] }
}

export const TOOL_TAG_OPEN = QWEN_WEB_TOOL_OPEN
export const TOOL_TAG_CLOSE = QWEN_WEB_TOOL_CLOSE
