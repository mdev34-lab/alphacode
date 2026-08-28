import { describe, expect, test } from "bun:test"
import {
  computeGenerationMetrics,
  createGenerationClock,
  isReceivedTextToken,
} from "../../src/session/generation-metrics"

describe("generation-metrics.isReceivedTextToken", () => {
  test("counts only non-empty text-delta as a received token", () => {
    expect(isReceivedTextToken({ type: "text-start" })).toBe(false)
    expect(isReceivedTextToken({ type: "text-delta", text: "" })).toBe(false)
    expect(isReceivedTextToken({ type: "text-delta", text: "hi" })).toBe(true)
    expect(isReceivedTextToken({ type: "reasoning-start" })).toBe(false)
    expect(isReceivedTextToken({ type: "reasoning-delta", text: "think" })).toBe(false)
    expect(isReceivedTextToken({ type: "tool-input-delta", text: "{" })).toBe(false)
    expect(isReceivedTextToken({ type: "tool-call" })).toBe(false)
    expect(isReceivedTextToken({ type: "step-finish" })).toBe(false)
  })
})

describe("generation-metrics.computeGenerationMetrics", () => {
  test("computes TTFT and tokens/sec from generation time and provider tokens", () => {
    expect(
      computeGenerationMetrics({
        requestedAt: 1000,
        firstOutputAt: 1842,
        generationMs: 1000,
        outputTokens: 48.7,
      }),
    ).toEqual({
      ttft: 842,
      tokensPerSecond: 48.7,
    })
  })

  test("omits TTFT when no generated output arrived", () => {
    expect(
      computeGenerationMetrics({
        requestedAt: 1000,
        generationMs: 500,
        outputTokens: 20,
      }),
    ).toEqual({
      tokensPerSecond: 40,
    })
  })

  test("omits tokens/sec without provider usage, tokens, or generation duration", () => {
    expect(
      computeGenerationMetrics({
        requestedAt: 1000,
        firstOutputAt: 1100,
        generationMs: 0,
        outputTokens: 20,
      }),
    ).toEqual({ ttft: 100 })
    expect(
      computeGenerationMetrics({
        requestedAt: 1000,
        firstOutputAt: 1100,
        generationMs: 250,
      }),
    ).toEqual({ ttft: 100 })
    expect(
      computeGenerationMetrics({
        requestedAt: 1000,
        firstOutputAt: 1100,
        generationMs: 250,
        outputTokens: 0,
      }),
    ).toEqual({ ttft: 100 })
  })
})

describe("generation-metrics.createGenerationClock", () => {
  test("measures streaming TTFT and tokens/sec for one request", () => {
    const clock = createGenerationClock()
    clock.startRequest(1000)
    clock.observe({ type: "step-start" }, 1010)
    clock.observe({ type: "text-start" }, 1800)
    clock.observe({ type: "text-delta", text: "" }, 1810)
    clock.observe({ type: "text-delta", text: "Hello" }, 1842)
    clock.observe({ type: "text-end" }, 2800)
    clock.observe({ type: "step-finish", usage: { outputTokens: 20 } }, 2842)
    clock.observe({ type: "finish", usage: { outputTokens: 20 } }, 2842)

    expect(clock.finish(3000)).toEqual({
      ttft: 842,
      tokensPerSecond: 20,
    })
  })

  test("does not use tool-call as TTFT", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "tool-call" }, 40)
    clock.observe({ type: "text-delta", text: "hello" }, 200)

    expect(clock.finish(300).ttft).toBe(200)
  })

  test("measures TTFT from first text token after a tool-call step", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "tool-call" }, 40)
    clock.observe({ type: "step-finish", usage: { outputTokens: 8 } }, 100)
    clock.observe({ type: "text-delta", text: "hello" }, 800)
    clock.observe({ type: "step-finish", usage: { outputTokens: 4 } }, 900)

    expect(clock.finish(1000)).toEqual({
      ttft: 800,
      tokensPerSecond: 40,
    })
  })

  test("does not start TTFT or tok/s from reasoning or tool-input deltas", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "reasoning-delta", text: "hmm" }, 50)
    clock.observe({ type: "tool-input-delta", text: "{" }, 60)
    clock.observe({ type: "tool-call" }, 70)
    clock.observe({ type: "text-delta", text: "ok" }, 180)
    clock.observe({ type: "step-finish", usage: { outputTokens: 10 } }, 280)

    expect(clock.finish(300)).toEqual({
      ttft: 180,
      tokensPerSecond: 100,
    })
  })

  test("omits both metrics when only a tool-call is produced", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "tool-call" }, 40)
    clock.observe({ type: "step-finish", usage: { outputTokens: 8 } }, 120)

    expect(clock.finish(200)).toEqual({})
  })

  test("does not count tool execution time between steps", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "text-delta", text: "a" }, 100)
    clock.observe({ type: "step-finish", usage: { outputTokens: 10 } }, 200)
    clock.observe({ type: "text-delta", text: "b" }, 800)
    clock.observe({ type: "step-finish", usage: { outputTokens: 10 } }, 900)

    expect(clock.finish(1000)).toEqual({
      ttft: 100,
      tokensPerSecond: 100,
    })
  })

  test("falls back to finish usage when step-finish has none", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "text-delta", text: "hmm" }, 50)
    clock.observe({ type: "step-finish" }, 150)
    clock.observe({ type: "finish", usage: { outputTokens: 5 } }, 150)

    expect(clock.finish(200)).toEqual({
      ttft: 50,
      tokensPerSecond: 50,
    })
  })

  test("does not double-count step-finish and finish usage", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "text-delta", text: "a" }, 10)
    clock.observe({ type: "step-finish", usage: { outputTokens: 4 } }, 110)
    clock.observe({ type: "finish", usage: { outputTokens: 4 } }, 110)

    expect(clock.finish(200)).toEqual({
      ttft: 10,
      tokensPerSecond: 40,
    })
  })

  test("omits tokens/sec for a same-millisecond non-streaming burst", () => {
    const clock = createGenerationClock()
    clock.startRequest(50)
    clock.observe({ type: "text-delta", text: "hello" }, 50)
    clock.observe({ type: "step-finish", usage: { outputTokens: 12 } }, 50)
    clock.observe({ type: "finish", usage: { outputTokens: 12 } }, 50)

    expect(clock.finish(50)).toEqual({ ttft: 0 })
  })

  test("omits both metrics when the model produced no output", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "step-start" }, 10)
    clock.observe({ type: "step-finish" }, 20)
    clock.observe({ type: "finish" }, 20)

    expect(clock.finish(30)).toEqual({})
  })

  test("resets timing across retries so metrics belong to the last attempt", () => {
    const clock = createGenerationClock()
    clock.startRequest(0)
    clock.observe({ type: "text-delta", text: "partial" }, 500)
    clock.startRequest(1000)
    clock.observe({ type: "text-delta", text: "ok" }, 1100)
    clock.observe({ type: "step-finish", usage: { outputTokens: 2 } }, 1300)

    expect(clock.finish(1400)).toEqual({
      ttft: 100,
      tokensPerSecond: 10,
    })
  })
})
