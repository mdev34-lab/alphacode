import { describe, expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "work" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to work", () => {
    expect(resolveAgent(agents)?.name).toBe("work")
    expect(resolveAgent(agents, "missing")?.name).toBe("work")
  })

  test("resolves the legacy build id onto work", () => {
    expect(resolveAgent(agents, "work")?.name).toBe("work")
  })

  test("prefers a real agent named build over the alias", () => {
    expect(resolveAgent([{ name: "work" }, { name: "work" }], "work")?.name).toBe("work")
  })

  test("uses the first agent when work is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})
