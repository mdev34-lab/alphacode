import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { CONTEXT_BAR_WIDTH, contextBarGlyphs, contextUsageFrom } from "../../src/feature-plugins/sidebar/context"

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "u1",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

const noModel = () => undefined

describe("sidebar context usage + bar (#241)", () => {
  test("no assistant output yet is UNKNOWN, not 0 tokens/0% used", () => {
    const usage = contextUsageFrom([], noModel)
    expect(usage).toEqual({ status: "unknown", tokens: 0 })
    // Unknown renders as a plain empty bar (no fill, no hatch/texture glyph) —
    // the "usage unknown" text (asserted on the View's detail string, not
    // exercised by this pure-function test) is what disambiguates it from a
    // genuine, measured 0%.
    const glyphs = contextBarGlyphs(usage)
    expect(glyphs).toBe("░".repeat(CONTEXT_BAR_WIDTH))
    expect(glyphs).not.toContain("█")
    expect(glyphs).not.toContain("▨")
  })

  test("usage exists but no model context limit resolves to unknown, rendered as a plain empty bar", () => {
    const usage = contextUsageFrom(
      [assistant({ tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      noModel,
    )
    expect(usage.status).toBe("unknown")
    expect(usage.tokens).toBe(1200)
    const glyphs = contextBarGlyphs(usage)
    // Unknown must render identically to the "no usage yet" unknown case: a
    // plain empty bar, never a hatch glyph (hatch glyphs render at a
    // different cell height than fill/empty glyphs in terminal fonts).
    expect(glyphs).toBe("░".repeat(CONTEXT_BAR_WIDTH))
    expect(glyphs).not.toContain("█")
    expect(glyphs).not.toContain("▨")
  })

  test("partial usage fills a proportional number of cells", () => {
    const usage = contextUsageFrom(
      [assistant({ tokens: { input: 29_523, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      () => ({ limit: { context: 200_000 } }),
    )
    expect(usage).toEqual({ status: "known", tokens: 29_723, percent: 15 })
    const glyphs = contextBarGlyphs(usage)
    expect(glyphs.length).toBe(CONTEXT_BAR_WIDTH)
    // 15% of 20 cells rounds to 3 filled cells.
    expect(glyphs).toBe("█".repeat(3) + "░".repeat(CONTEXT_BAR_WIDTH - 3))
  })

  test("near-limit usage fills almost the whole bar without overflowing it", () => {
    const usage = contextUsageFrom(
      [assistant({ tokens: { input: 183_800, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      () => ({ limit: { context: 200_000 } }),
    )
    expect(usage).toEqual({ status: "known", tokens: 184_000, percent: 92 })
    const glyphs = contextBarGlyphs(usage)
    expect(glyphs.length).toBe(CONTEXT_BAR_WIDTH)
    expect(glyphs).toBe("█".repeat(18) + "░".repeat(CONTEXT_BAR_WIDTH - 18))
  })

  test("percent above 100 (e.g. a stale/overshot limit) still clamps to a full bar", () => {
    const usage = contextUsageFrom(
      [assistant({ tokens: { input: 500_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })],
      () => ({ limit: { context: 200_000 } }),
    )
    expect(usage.status).toBe("known")
    const glyphs = contextBarGlyphs(usage)
    expect(glyphs).toBe("█".repeat(CONTEXT_BAR_WIDTH))
  })
})
