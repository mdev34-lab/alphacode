import { describe, expect, test } from "bun:test"
import {
  abortedError,
  challengeError,
  classifyJsonError,
  classifyStatus,
  classifyTransportFailure,
  isAbortLike,
  isChallengeMessage,
  isChatMissingMessage,
  isHtmlBody,
  isNoDisplayError,
  isQuotaMessage,
  isWafMessage,
  loginRequiredError,
  QwenWebError,
  sessionExpiredError,
} from "@/provider/qwen-web/errors"

describe("QwenWebError", () => {
  test("carries code, retryability and status", () => {
    const error = new QwenWebError({ code: "rate_limited", message: "slow down", retryable: true, status: 429 })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("rate_limited")
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(429)
    expect(QwenWebError.isInstance(error)).toBe(true)
    expect(QwenWebError.isInstance(new Error("x"))).toBe(false)
  })

  test("login helpers point at /auth", () => {
    expect(loginRequiredError().code).toBe("login_required")
    expect(loginRequiredError().message).toContain("/auth")
    expect(loginRequiredError().retryable).toBe(false)
    expect(sessionExpiredError().code).toBe("session_expired")
    expect(sessionExpiredError().status).toBe(401)
    expect(challengeError().code).toBe("challenge")
    expect(challengeError().message).toMatch(/never solves challenges/i)
  })

  test("abortedError is AbortError-shaped", () => {
    const error = abortedError()
    expect(error.code).toBe("aborted")
    expect(error.name).toBe("AbortError")
    expect(isAbortLike(error)).toBe(true)
    expect(isAbortLike(new DOMException("x", "AbortError"))).toBe(true)
    expect(isAbortLike({ name: "AbortError" })).toBe(true)
    expect(isAbortLike(new Error("boom"))).toBe(false)
  })
})

describe("message classifiers", () => {
  test("quota detection", () => {
    expect(isQuotaMessage("Rate limit exceeded, retry later")).toBe(true)
    expect(isQuotaMessage("HTTP 429 Too Many Requests")).toBe(true)
    expect(isQuotaMessage("insufficient_quota")).toBe(true)
    expect(isQuotaMessage("all good")).toBe(false)
  })

  test("chat-missing detection", () => {
    expect(isChatMissingMessage("chat is not exist")).toBe(true)
    expect(isChatMissingMessage("no such chat")).toBe(true)
    expect(isChatMissingMessage("chat created")).toBe(false)
  })

  test("WAF / challenge detection", () => {
    expect(isWafMessage("FAIL_SYS_USER_VALIDATE")).toBe(true)
    expect(isWafMessage("rgv587_error happened")).toBe(true)
    expect(isChallengeMessage("please complete the captcha")).toBe(true)
    expect(isChallengeMessage("human verification required")).toBe(true)
    expect(isChallengeMessage("normal response")).toBe(false)
  })

  test("html detection", () => {
    expect(isHtmlBody("<!DOCTYPE html><html>")).toBe(true)
    expect(isHtmlBody('  <html lang="en">')).toBe(true)
    expect(isHtmlBody('{"success":true}')).toBe(false)
  })

  test("no-display detection", () => {
    expect(isNoDisplayError(new Error("Missing X server (did you mean --headless?)"))).toBe(true)
    expect(isNoDisplayError(new Error("Unable to open X display"))).toBe(true)
    expect(isNoDisplayError(new Error("browser has not been found"))).toBe(false)
  })
})

describe("classifyJsonError", () => {
  test("returns undefined for non-JSON and success payloads", () => {
    expect(classifyJsonError("not json", 200)).toBeUndefined()
    expect(classifyJsonError('{"success":true,"data":{}}', 200)).toBeUndefined()
    expect(classifyJsonError("[]", 200)).toBeUndefined()
  })

  test("WAF ret codes become challenges", () => {
    const error = classifyJsonError('{"ret":["FAIL_SYS_USER_VALIDATE"]}', 200)
    expect(error?.code).toBe("challenge")
    expect(error?.retryable).toBe(false)
  })

  test("success:false with 401 becomes session_expired", () => {
    const error = classifyJsonError('{"success":false,"message":"login required"}', 401)
    expect(error?.code).toBe("session_expired")
  })

  test("rate limit payloads carry the wait hint", () => {
    const error = classifyJsonError('{"success":false,"code":"RateLimited","message":"slow","data":{"num":2}}', 429)
    expect(error?.code).toBe("rate_limited")
    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain("2 hour")
  })

  test("{error} shapes map quota vs generic", () => {
    expect(classifyJsonError('{"error":"rate limit hit"}', 200)?.code).toBe("rate_limited")
    const generic = classifyJsonError('{"error":{"message":"kaput"}}', 500)
    expect(generic?.code).toBe("upstream_error")
    expect(generic?.retryable).toBe(true)
  })
})

describe("classifyStatus", () => {
  test("2xx is undefined", () => {
    expect(classifyStatus(200)).toBeUndefined()
  })
  test("401/403/429/503 mapping", () => {
    expect(classifyStatus(401)?.code).toBe("session_expired")
    expect(classifyStatus(403)?.code).toBe("session_expired")
    expect(classifyStatus(429)?.code).toBe("rate_limited")
    expect(classifyStatus(503)?.code).toBe("upstream_unavailable")
    expect(classifyStatus(503)?.retryable).toBe(true)
    expect(classifyStatus(400)?.retryable).toBe(false)
  })
})

describe("classifyTransportFailure", () => {
  test("network failures are retryable, aborts are not", () => {
    expect(classifyTransportFailure(new Error("fetch failed")).code).toBe("network_error")
    expect(classifyTransportFailure(new Error("fetch failed")).retryable).toBe(true)
    expect(classifyTransportFailure(abortedError()).code).toBe("aborted")
    expect(classifyTransportFailure(new Error("weird")).code).toBe("browser_error")
  })
})
