import { describe, expect, test } from "bun:test"
import {
  abortedError,
  CHALLENGE_WINDOW_OPEN_DETAIL,
  challengeError,
  classifyJsonError,
  classifyStatus,
  classifyStreamError,
  classifyTransportFailure,
  classifyTruncatedJson,
  emptyResponseError,
  isAbortLike,
  isChallengeMessage,
  isChatMissingMessage,
  isHtmlBody,
  isNoDisplayError,
  isQuotaMessage,
  isStaleChatCode,
  isStaleChatError,
  isWafMessage,
  loginRequiredError,
  nonStreamResponseError,
  normalizeUpstreamCode,
  QwenWebError,
  sessionExpiredError,
  staleChatError,
  STALE_CHAT_UPSTREAM_CODE,
} from "@opencode-ai/webchat/adapters/qwen/errors"

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
    // The default never promises a window that was never opened.
    expect(challengeError().message).toContain("No browser window could be opened")
    expect(challengeError(CHALLENGE_WINDOW_OPEN_DETAIL).message).toContain("visible browser window")
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

describe("stale-chat classification (issue 232)", () => {
  // The exact shape reported in the field: a deleted chat answering with a
  // CHAT_NOT_FOUND code and a "start a new chat" message.
  const DELETED_BODY = JSON.stringify({
    success: false,
    code: "CHAT_NOT_FOUND",
    message: "This chat has been deleted. Please start a new chat to continue.",
  })

  test("code detection is code-first, case-insensitive and chat-specific", () => {
    expect(normalizeUpstreamCode("CHAT_NOT_FOUND")).toBe("chat not found")
    expect(isStaleChatCode("CHAT_NOT_FOUND")).toBe(true)
    expect(isStaleChatCode("chat_not_exist")).toBe(true)
    expect(isStaleChatCode("Chat Has Been Deleted")).toBe(true)
    expect(isStaleChatCode("no-such-chat")).toBe(true)
    // A bare Not_Found is a retired *model* id, not a stale chat.
    expect(isStaleChatCode("Not_Found")).toBe(false)
    expect(isStaleChatCode("RateLimited")).toBe(false)
    expect(isStaleChatCode("Unauthorized")).toBe(false)
  })

  test("message detection is case-insensitive, chat-specific, and covers deletions", () => {
    expect(isChatMissingMessage("This chat has been deleted. Please start a new chat to continue.")).toBe(true)
    expect(isChatMissingMessage("CHAT NOT FOUND")).toBe(true)
    expect(isChatMissingMessage("Chat is NOT exist")).toBe(true)
    expect(isChatMissingMessage("chat created")).toBe(false)
    expect(isChatMissingMessage("model not found")).toBe(false)
    expect(isChatMissingMessage("Model does not exist")).toBe(false)
    expect(isChatMissingMessage("Attachment file does not exist")).toBe(false)
  })

  test("the deleted-chat payload is a retryable stale-chat error, not a dead end", () => {
    for (const status of [200, 400, 404]) {
      const error = classifyJsonError(DELETED_BODY, status)
      expect(error).toBeDefined()
      expect(error?.code).toBe("upstream_error")
      expect(error?.retryable).toBe(true)
      expect(error?.upstreamCode).toBe(STALE_CHAT_UPSTREAM_CODE)
      expect(error?.message).toContain("CHAT_NOT_FOUND")
      expect(error?.message).toContain("deleted")
      expect(isStaleChatError(error)).toBe(true)
    }
  })

  test("OpenAI-style error shapes carry the code too", () => {
    const error = classifyJsonError('{"error":{"code":"CHAT_NOT_FOUND","message":"gone"}}', 200)
    expect(isStaleChatError(error)).toBe(true)
    expect(error?.retryable).toBe(true)
  })

  test("mid-stream error events classify the same way", () => {
    const byCode = classifyStreamError("CHAT_NOT_FOUND", "This chat has been deleted.")
    expect(isStaleChatError(byCode)).toBe(true)
    expect(byCode.retryable).toBe(true)
    const byMessage = classifyStreamError("E_UPSTREAM", "Sorry, the chat does not exist anymore")
    expect(isStaleChatError(byMessage)).toBe(true)
    // Unrelated stream errors keep their generic retryable classification.
    const generic = classifyStreamError("E1", "kaput")
    expect(isStaleChatError(generic)).toBe(false)
    expect(generic.code).toBe("upstream_error")
  })

  test("message fallback cannot turn model or file errors into stale-chat errors", () => {
    const modelMessage = classifyStreamError("Not_Found", "Model does not exist")
    const fileMessage = classifyStreamError("File_Not_Found", "Attachment file does not exist")
    expect(isStaleChatError(modelMessage)).toBe(false)
    expect(isStaleChatError(fileMessage)).toBe(false)

    const modelBody = classifyJsonError('{"success":false,"code":"Not_Found","message":"Model does not exist"}', 200)
    const fileBody = classifyJsonError('{"success":false,"message":"Attachment file does not exist"}', 200)
    expect(isStaleChatError(modelBody)).toBe(false)
    expect(isStaleChatError(fileBody)).toBe(false)

    // Explicit chat-specific upstream codes still win over generic message text.
    expect(isStaleChatError(classifyStreamError("CHAT_NOT_FOUND", "Model does not exist"))).toBe(true)
    expect(
      isStaleChatError(classifyJsonError('{"success":false,"code":"CHAT_NOT_FOUND","message":"Model does not exist"}', 200)),
    ).toBe(true)
  })

  test("stale errors never masquerade as quota or challenge", () => {
    const error = classifyJsonError(DELETED_BODY, 200)
    expect(error?.code).not.toBe("rate_limited")
    expect(error?.code).not.toBe("challenge")
    expect(isStaleChatError(classifyJsonError('{"success":false,"code":"RateLimited","message":"slow"}', 429))).toBe(
      false,
    )
  })

  test("staleChatError stamps the canonical recovery marker", () => {
    const error = staleChatError({ status: 200, upstreamCode: "CHAT_NOT_FOUND", detail: "deleted" })
    expect(error.upstreamCode).toBe(STALE_CHAT_UPSTREAM_CODE)
    expect(error.retryable).toBe(true)
    expect(isStaleChatError(error)).toBe(true)
    expect(isStaleChatError(loginRequiredError())).toBe(false)
    expect(isStaleChatError(new Error("chat not found"))).toBe(false)
  })
})

describe("honest empty/truncated error reporting (issue 232)", () => {
  test("empty responses do not promise a safe retry or trigger an automatic retry", () => {
    const error = emptyResponseError()
    expect(error.code).toBe("invalid_response")
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("empty response")
    expect(error.message).toContain("rolled back from local thread history")
    expect(error.message).not.toContain("Nothing was committed")
    expect(error.message).not.toContain("retrying is safe")
  })

  test("truncated JSON salvages the visible fields instead of claiming login", () => {
    // A >8k error body arrives at the classifier cut mid-string: JSON.parse fails.
    const truncatedStale = `{"success":false,"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. ${"x".repeat(9000)}`
    expect(() => JSON.parse(truncatedStale)).toThrow()
    const stale = classifyTruncatedJson(truncatedStale, 200)
    expect(isStaleChatError(stale)).toBe(true)
    expect(stale.retryable).toBe(true)

    const truncatedRate = `{"success":false,"code":"RateLimited","message":"quota exceeded ${"y".repeat(9000)}`
    const rate = classifyTruncatedJson(truncatedRate, 200)
    expect(rate.code).toBe("rate_limited")
    expect(rate.retryable).toBe(true)
  })

  test("unrecognizable truncated JSON is an honest invalid_response", () => {
    const truncated = `{"success":false,"data":{"details":"something broke badly ${"z".repeat(9000)}`
    const error = classifyTruncatedJson(truncated, 200)
    expect(error.code).toBe("invalid_response")
    expect(error.message).not.toContain("login")
    expect(error.message).toContain("truncated")
    expect(error.message).toContain("something broke badly")
    expect(error.retryable).toBe(false)
    // Server-side statuses stay retryable.
    expect(classifyTruncatedJson(truncated, 503).retryable).toBe(true)
  })

  test("non-stream bodies report what they are, never a bogus login", () => {
    const empty = nonStreamResponseError("", 200)
    expect(empty.code).toBe("invalid_response")
    expect(empty.message).toContain("<empty body>")
    expect(empty.message).not.toContain("login")
    const text = nonStreamResponseError("weird plain text", 200)
    expect(text.message).toContain("weird plain text")
    expect(text.retryable).toBe(false)
    expect(nonStreamResponseError("x", 502).retryable).toBe(true)
  })
})
