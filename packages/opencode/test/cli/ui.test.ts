import { expect, test } from "bun:test"
import { logo } from "@opencode-ai/tui/logo"
import { UI } from "../../src/cli/ui"

test("plain wordmark is derived from the shared logo art", () => {
  const rows = UI.logo().split("\n")
  expect(rows).toHaveLength(logo.left.length)
  expect(new Set(rows.map((row) => row.length))).toEqual(new Set([logo.left[0]!.length + 1 + logo.right[0]!.length]))
})

test("plain wordmark expands every shadow mark", () => {
  expect(UI.logo()).not.toMatch(/[_^~,\u2800]/)
})

test("plain wordmark honours the pad", () => {
  expect(
    UI.logo("  ")
      .split("\n")
      .every((row) => row.startsWith("  ")),
  ).toBe(true)
})
