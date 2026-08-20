import { expect, test } from "bun:test"
import { badge, go, logo } from "../src/logo"

// "," is only expanded by tui/component/logo.tsx, so the shared art must not use it.
const alphabet = new Set([" ", "▀", "▄", "█", "_", "^", "~"])

const templates = {
  "logo.left": logo.left,
  "logo.right": logo.right,
  "go.left": go.left,
  "go.right": go.right,
  badge,
}

for (const [name, rows] of Object.entries(templates)) {
  test(`${name} is a rectangular four row template`, () => {
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.length)).size).toBe(1)
  })

  test(`${name} only uses universally supported glyphs`, () => {
    expect(rows.flatMap((row) => Array.from(row)).filter((char) => !alphabet.has(char))).toEqual([])
  })
}

test("badge is the leading glyph of the wordmark", () => {
  expect(badge).toEqual(logo.left.map((row) => row.slice(0, 4)))
})

// Half-cell bitmap of the wordmark: two rows of pixels per template row, so
// ascender and baseline alignment can be asserted directly.
const pixels = logo.left
  .map((row, index) => row + " " + (logo.right[index] ?? ""))
  .flatMap((row) => {
    const top = Array.from(row).map((char) => "█▀^".includes(char))
    const bottom = Array.from(row).map((char) => "█▄".includes(char))
    return [top, bottom]
  })

const columnTop = (column: number) => pixels.findIndex((row) => row[column])

test("every ascender rises exactly one half cell above x-height", () => {
  // x-height starts at template row 1 (half-cell row 2); ascenders start at row 1.
  const tops = new Set(pixels[0]!.map((_, column) => columnTop(column)).filter((top) => top >= 0 && top < 2))
  expect([...tops]).toEqual([1])
})

test("no glyph rises above the ascender line", () => {
  expect(pixels[0]!.some(Boolean)).toBe(false)
})

test("wordmark renders alphacode with an even baseline", () => {
  expect(pixels.map((row) => row.map((on) => (on ? "#" : ".")).join("")).join("\n")).toMatchSnapshot()
})
