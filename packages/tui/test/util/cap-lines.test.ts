import { describe, expect, test } from "bun:test"
import { capLineLength, capOutputLines, MAX_OUTPUT_LINE_LENGTH } from "../../src/util/cap-lines"

describe("capLineLength", () => {
  test("leaves normal lines below the cap untouched", () => {
    expect(capLineLength("")).toBe("")
    expect(capLineLength("hello")).toBe("hello")
    const atCap = "a".repeat(MAX_OUTPUT_LINE_LENGTH)
    expect(capLineLength(atCap)).toBe(atCap)
    expect(capLineLength("short line")).toHaveLength("short line".length)
  })

  test("caps a single line that exceeds the cap with a truncation marker", () => {
    const line = "a".repeat(MAX_OUTPUT_LINE_LENGTH + 1)
    const capped = capLineLength(line)
    expect(capped.length).toBeLessThanOrEqual(MAX_OUTPUT_LINE_LENGTH + 24)
    expect(capped).toContain("[+")
    expect(capped).toContain("chars]")
    expect(capped.startsWith("a".repeat(MAX_OUTPUT_LINE_LENGTH - 24))).toBe(true)
    // No data is fabricated: the visible prefix is a real prefix of the input.
    const visible = capped.split(" ... ")[0]
    expect(line.startsWith(visible)).toBe(true)
  })

  test("reports the number of hidden characters", () => {
    const line = "a".repeat(MAX_OUTPUT_LINE_LENGTH + 100)
    const capped = capLineLength(line)
    const match = /\[\+(\d+) chars\]$/.exec(capped)
    expect(match).not.toBeNull()
    const hidden = Number(match?.[1])
    const visible = capped.split(" ... ")[0].length
    // Hidden count = the tail of the original not shown in the visible prefix
    // (the marker text itself is not part of the original line).
    expect(hidden).toBe(line.length - visible)
  })

  test("respects a custom cap", () => {
    const line = "abcdefghij"
    const capped = capLineLength(line, 5)
    expect(capped).toContain("[+")
    expect(capped.startsWith(" ... [+")).toBe(true)
    const hidden = Number(/\[\+(\d+) chars\]$/.exec(capped)?.[1])
    expect(hidden).toBe(line.length)
  })
})

describe("capOutputLines", () => {
  test("caps multiple long lines independently while keeping short lines intact", () => {
    const long1 = "a".repeat(MAX_OUTPUT_LINE_LENGTH + 50)
    const long2 = "b".repeat(MAX_OUTPUT_LINE_LENGTH * 3)
    const output = [long1, "short", long2].join("\n")
    const capped = capOutputLines(output).split("\n")
    expect(capped).toHaveLength(3)
    expect(capped[0]).toContain("[+")
    expect(capped[1]).toBe("short")
    expect(capped[2]).toContain("[+")
    expect(capped[2].startsWith("b")).toBe(true)
  })

  test("preserves multiline behavior for all-short output", () => {
    const output = "line one\nline two\nline three\n"
    expect(capOutputLines(output)).toBe(output)
    const empty = "\n\n"
    expect(capOutputLines(empty)).toBe(empty)
  })

  test("caps an over-long line in the middle of multiline output (the reported bug shape)", () => {
    // The issue's worst case: short lines render fine but a single offending
    // line blows past the cap and floods/jitters the TUI viewport.
    const pathological = "x".repeat(4000)
    const output = `normal line one\n${pathological}\nnormal line three`
    const capped = capOutputLines(output).split("\n")
    expect(capped).toHaveLength(3)
    expect(capped[0]).toBe("normal line one")
    expect(capped[2]).toBe("normal line three")
    expect(capped[1].length).toBeLessThanOrEqual(MAX_OUTPUT_LINE_LENGTH + 24)
    expect(capped[1]).toContain("chars]")
  })

  test("does not alter output where every line fits", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    expect(capOutputLines(output)).toBe(output)
  })
})
