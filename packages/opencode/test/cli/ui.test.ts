import { expect, test } from "bun:test"
import { logo } from "@opencode-ai/tui/logo"
import { UI } from "../../src/cli/ui"

test("plain wordmark is derived from the shared logo art", () => {
  // A CRLF checkout can smuggle \r into either side; compare row by row with
  // the exact wordmark transform instead of absolute widths.
  const clean = (value: string) => value.replaceAll("\r", "")
  const rows = clean(UI.logo()).split("\n")
  expect(rows).toHaveLength(logo.left.length)
  for (const [index, row] of rows.entries()) {
    expect(row).toBe(
      clean(logo.left[index] + " " + (logo.right[index] ?? ""))
        .replaceAll("^", "▀")
        .replaceAll(/[_~,]/g, " "),
    )
  }
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
