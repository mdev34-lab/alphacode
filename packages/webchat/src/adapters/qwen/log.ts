/**
 * Logging helpers for the Qwen Web provider.
 *
 * Two rules:
 * 1. Never emit cookies, authorization headers, tokens or full prompts.
 * 2. Debug output is opt-in (`QWEN_WEB_DEBUG=1`) and ASCII-safe.
 */
import { QWEN_WEB_ENV } from "./constants"

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-auth-token",
  "bx-ua",
  "bx-umidtoken",
  "set-cookie",
])

const SENSITIVE_VALUE_PATTERN =
  /(token\s*[=:]\s*)([^;\s,}"]+)|(bearer\s+)([A-Za-z0-9._~+/=-]+)|(cookie\s*[=:]\s*)([^;\n]+)/gi

export function isDebugEnabled(): boolean {
  const value = process.env[QWEN_WEB_ENV.debug]?.toLowerCase()
  return value === "1" || value === "true"
}

/** Redact a header map for logging. Sensitive values become `[redacted]`. */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "[redacted]" : value
  }
  return result
}

/** Redact cookies/tokens embedded in an arbitrary string. */
export function redactString(value: string): string {
  return value.replace(SENSITIVE_VALUE_PATTERN, (_match, ...groups) => {
    // groups: [tokenPrefix, tokenValue, bearerPrefix, bearerValue, cookiePrefix, cookieValue]
    const [tokenPrefix, , bearerPrefix, , cookiePrefix] = groups
    const prefix = tokenPrefix ?? bearerPrefix ?? cookiePrefix ?? ""
    return `${prefix}[redacted]`
  })
}

/**
 * Summarize a payload for logs without dumping user content:
 * byte size plus a short whitespace-collapsed preview.
 */
export function summarizePayload(value: string, previewChars = 120): { bytes: number; preview: string } {
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    preview: redactString(value.replace(/\s+/g, " ").trim().slice(0, previewChars)),
  }
}

export function debug(namespace: string, message: string, fields?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return
  if (fields === undefined) {
    console.debug(`[qwen-web:${namespace}] ${message}`)
    return
  }
  console.debug(`[qwen-web:${namespace}] ${message}`, sanitizeFields(fields))
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (/cookie|token|auth|secret|password|key/i.test(key)) {
      result[key] = "[redacted]"
      continue
    }
    if (typeof value === "string") {
      result[key] = redactString(value.length > 500 ? value.slice(0, 500) + "…" : value)
      continue
    }
    result[key] = value
  }
  return result
}
