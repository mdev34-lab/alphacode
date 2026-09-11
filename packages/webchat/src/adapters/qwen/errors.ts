/**
 * Typed errors for the Qwen Web provider.
 *
 * The transport/session layers throw these; the AI SDK boundary (`sdk.ts`)
 * converts them into `APICallError` so AlphaCode's existing error handling,
 * retry classification and TUI rendering keep working unchanged.
 */

export type QwenWebErrorCode =
  | "login_required"
  | "session_expired"
  | "rate_limited"
  | "upstream_error"
  | "upstream_unavailable"
  | "network_error"
  | "challenge"
  | "browser_error"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "unsupported"

export class QwenWebError extends Error {
  override name = "QwenWebError"
  readonly code: QwenWebErrorCode
  readonly retryable: boolean
  /** Upstream error code, when one was reported. */
  readonly upstreamCode?: string
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number
  /** Suggested wait before retrying, when the upstream provided one. */
  readonly retryAfterMs?: number

  constructor(input: {
    code: QwenWebErrorCode
    message: string
    retryable?: boolean
    upstreamCode?: string
    status?: number
    retryAfterMs?: number
    cause?: unknown
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined)
    this.code = input.code
    this.retryable = input.retryable ?? false
    this.upstreamCode = input.upstreamCode
    this.status = input.status
    this.retryAfterMs = input.retryAfterMs
  }

  static isInstance(input: unknown): input is QwenWebError {
    return input instanceof QwenWebError
  }
}

export function loginRequiredError(detail?: string): QwenWebError {
  return new QwenWebError({
    code: "login_required",
    retryable: false,
    status: 401,
    message:
      "Qwen Web login required. Run `/auth`, choose `qwen-web`, and complete the login in the browser window. " +
      (detail ?? "No authenticated Qwen session was found."),
  })
}

export function sessionExpiredError(detail?: string): QwenWebError {
  return new QwenWebError({
    code: "session_expired",
    retryable: false,
    status: 401,
    message:
      "Qwen Web session expired. Run `/auth`, choose `qwen-web`, and log in again. " +
      (detail ?? "The stored browser session is no longer valid."),
  })
}

/** Detail when a visible challenge window was opened for the user. */
export const CHALLENGE_WINDOW_OPEN_DETAIL =
  "A visible browser window has been opened — solve the challenge there, then retry."
/** Detail when no visible window can open (explicit headless, no display). */
export const CHALLENGE_NO_WINDOW_DETAIL =
  "No browser window could be opened (headless mode with no display, or QWEN_WEB_HEADLESS is set). " +
  "Open chat.qwen.ai in your own browser to check for verification prompts, then retry."

export function challengeError(detail?: string): QwenWebError {
  return new QwenWebError({
    code: "challenge",
    retryable: false,
    status: 403,
    message:
      "Qwen is showing a human-verification challenge, which paused this run. " +
      "AlphaCode never solves challenges automatically. " +
      (detail ?? CHALLENGE_NO_WINDOW_DETAIL),
  })
}

export function abortedError(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web request was aborted", retryable: false })
  error.name = "AbortError"
  return error
}

export function isAbortLike(input: unknown): boolean {
  if (input instanceof DOMException) return input.name === "AbortError"
  if (QwenWebError.isInstance(input)) return input.code === "aborted"
  if (!input || typeof input !== "object") return false
  const maybe = input as { name?: unknown; code?: unknown; message?: unknown }
  if (maybe.name === "AbortError" || maybe.code === "ABORT_ERR") return true
  // Only the DOMException's own "operation was aborted" text counts. A loose
  // substring match would also swallow Playwright navigation aborts
  // (`net::ERR_ABORTED`, "aborted by user"), which are browser/navigation
  // failures and must classify as retryable, not as a request abort.
  return typeof maybe.message === "string" && /operation was aborted/i.test(maybe.message)
}

/** Classify a mid-stream `data: {"error": ...}` payload. */
export function classifyStreamError(code: string, message: string): QwenWebError {
  const detail = `${code} ${message}`.slice(0, 300)
  if (isQuotaMessage(detail)) {
    return new QwenWebError({
      code: "rate_limited",
      retryable: true,
      upstreamCode: code,
      message: `Qwen usage limit reached mid-stream (${message.slice(0, 200)}). Wait a little and retry, or switch to a smaller task.`,
    })
  }
  if (code === "waf_challenge" || isChallengeMessage(detail)) {
    return new QwenWebError({
      code: "challenge",
      retryable: false,
      upstreamCode: code,
      message:
        "Qwen interrupted the stream with a human-verification challenge. Complete it in the Qwen browser profile, then retry.",
    })
  }
  return new QwenWebError({
    code: "upstream_error",
    retryable: true,
    upstreamCode: code,
    message: `Qwen stream error: ${message.slice(0, 280) || code || "unknown"}`,
  })
}

/** A stream that went quiet without a terminating event (`QwenWebError` code `"timeout"`). */
export function isStallTimeout(input: unknown): boolean {
  return QwenWebError.isInstance(input) && input.code === "timeout"
}

const QUOTA_PATTERNS = [
  "allocated quota exceeded",
  "quota exceeded",
  "increase your quota",
  "token-limit",
  "insufficient quota",
  "insufficient_quota",
  "rate limit",
  "ratelimited",
  "rate_limited",
  "too many requests",
  "overloaded",
]

export function isQuotaMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return QUOTA_PATTERNS.some((pattern) => normalized.includes(pattern))
}

const CHAT_MISSING_PATTERNS = ["is not exist", "not exist", "does not exist", "chat not found", "no such chat"]

export function isChatMissingMessage(message: string): boolean {
  return CHAT_MISSING_PATTERNS.some((pattern) => message.includes(pattern))
}

const WAF_PATTERNS = [
  "fail_sys_user_validate",
  "rgv587_error",
  "denyfromx5",
  "aliyun_waf",
  "_____tmd_____",
  "security verification",
  "user validate",
]

export function isWafMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return WAF_PATTERNS.some((pattern) => normalized.includes(pattern))
}

export function isHtmlBody(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(value)
}

const CHALLENGE_PATTERNS = [...WAF_PATTERNS, "captcha", "human verification", "verify you are human", "security check"]

export function isChallengeMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return CHALLENGE_PATTERNS.some((pattern) => normalized.includes(pattern))
}

const NO_DISPLAY_PATTERNS = [
  "missing x server",
  "unable to open x display",
  "could not open x display",
  "no display",
  "display=",
  "headless shell",
  "xvfb",
]

/** True when a browser launch failed because there is no display available. */
export function isNoDisplayError(input: unknown): boolean {
  const message = input instanceof Error ? input.message : String(input)
  const normalized = message.toLowerCase()
  return NO_DISPLAY_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/**
 * Classify an upstream JSON error payload into a typed error.
 *
 * Qwen reports failures in several shapes; this mirrors the shapes observed
 * in the web client: `{success:false,...}`, `{ret:[...]}`, `{error:...}`,
 * and `{data:{details,...}}`.
 */
export function classifyJsonError(raw: string, status: number): QwenWebError | undefined {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined

  const ret = parsed.ret
  if (Array.isArray(ret)) {
    const joined = ret.join(",")
    if (joined.includes("FAIL_SYS_USER_VALIDATE") || joined.includes("RGV587_ERROR")) {
      return new QwenWebError({
        code: "challenge",
        retryable: false,
        status,
        upstreamCode: "waf_challenge",
        message: `Qwen anti-bot validation failed (${joined.slice(0, 160)}). Complete the verification in the browser window, then retry.`,
      })
    }
  }

  const details: unknown = parsed?.data?.details ?? parsed?.message ?? parsed?.error?.message ?? parsed?.error
  const detailText = typeof details === "string" ? details : ""
  const code: string | undefined =
    typeof parsed?.data?.code === "string"
      ? parsed.data.code
      : typeof parsed?.code === "string"
        ? parsed.code
        : undefined

  if (detailText && isWafMessage(detailText)) {
    return new QwenWebError({
      code: "challenge",
      retryable: false,
      status,
      upstreamCode: "waf_challenge",
      message: `Qwen anti-bot validation failed. Complete the verification in the browser window, then retry.`,
    })
  }

  if (detailText && isChatMissingMessage(detailText)) {
    return new QwenWebError({
      code: "upstream_error",
      retryable: true,
      status,
      upstreamCode: "chat_not_exist",
      message: `Qwen chat session is no longer valid (${detailText.slice(0, 160)}).`,
    })
  }

  if (detailText && /chat is in progress|the chat is in progress/i.test(detailText)) {
    return new QwenWebError({
      code: "upstream_error",
      retryable: true,
      status,
      upstreamCode: "chat_in_progress",
      message: "Qwen reports the chat is still generating. Retry shortly.",
    })
  }

  if (parsed?.success === false) {
    const normalizedCode = code ?? "UpstreamError"
    if (
      status === 401 ||
      normalizedCode === "Unauthorized" ||
      (detailText && /login|session|unauthorized|authenticate/i.test(detailText))
    ) {
      return sessionExpiredError(detailText.slice(0, 200))
    }
    if (normalizedCode === "RateLimited" || status === 429 || (detailText && isQuotaMessage(detailText))) {
      const wait =
        typeof parsed?.data?.num === "number" ? ` Wait about ${parsed.data.num} hour(s) before trying again.` : ""
      return new QwenWebError({
        code: "rate_limited",
        retryable: true,
        status: 429,
        upstreamCode: normalizedCode,
        message: `Qwen rate limit reached: ${detailText.slice(0, 200)}.${wait}`,
      })
    }
    return new QwenWebError({
      code: "upstream_error",
      retryable: status >= 500,
      status,
      upstreamCode: normalizedCode,
      message: `Qwen upstream error (${normalizedCode}): ${detailText.slice(0, 300) || "unknown error"}`,
    })
  }

  if (parsed?.error) {
    const message =
      typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error))
    if (isQuotaMessage(message)) {
      return new QwenWebError({
        code: "rate_limited",
        retryable: true,
        status: 429,
        message: `Qwen rate limit reached: ${message.slice(0, 200)}`,
      })
    }
    return new QwenWebError({
      code: "upstream_error",
      retryable: status >= 500,
      status,
      message: `Qwen upstream error: ${message.slice(0, 300)}`,
    })
  }

  return undefined
}

/** Classify an HTTP status into a typed error (no body inspection). */
export function classifyStatus(status: number, statusText?: string): QwenWebError | undefined {
  if (status >= 200 && status < 300) return undefined
  if (status === 401 || status === 403)
    return sessionExpiredError(`Upstream responded with ${status} ${statusText ?? ""}`.trim())
  if (status === 429) {
    return new QwenWebError({
      code: "rate_limited",
      retryable: true,
      status,
      message: "Qwen rate limit reached (HTTP 429).",
    })
  }
  if (status === 502 || status === 503 || status === 504) {
    return new QwenWebError({
      code: "upstream_unavailable",
      retryable: true,
      status,
      message: `Qwen is temporarily unavailable (HTTP ${status}).`,
    })
  }
  return new QwenWebError({
    code: "upstream_error",
    retryable: status >= 500,
    status,
    message: `Qwen request failed (HTTP ${status}${statusText ? ` ${statusText}` : ""}).`,
  })
}

/** Network-level failures (DNS, reset, timeout) are retryable; aborts are not. */
export function classifyTransportFailure(input: unknown): QwenWebError {
  if (QwenWebError.isInstance(input)) return input
  if (isAbortLike(input)) return abortedError()
  const message = input instanceof Error ? input.message : String(input)
  if (/timeout|timed out|stall|econnreset|enotfound|econnrefused|fetch failed|network/i.test(message)) {
    return new QwenWebError({
      code: "network_error",
      retryable: true,
      message: `Qwen network failure: ${message.slice(0, 300)}`,
      cause: input,
    })
  }
  return new QwenWebError({
    code: "browser_error",
    retryable: true,
    message: `Qwen browser transport failure: ${message.slice(0, 300)}`,
    cause: input,
  })
}
