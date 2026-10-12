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

test("wordmark renders silvercode with an even baseline", () => {
  expect(pixels.map((row) => row.map((on) => (on ? "#" : ".")).join("")).join("\n")).toMatchSnapshot()
})

// Independent expectation of the glyphs: the wordmark must actually spell
// "silver" (muted half) + "code" (highlighted half). Each entry is the glyph on
// the half-cell grid, pixel rows 1-6 (row 1 is the ascender line, row 6 the
// baseline): "#" ink, "s" shadow counter, "." empty. If the art drifts back to
// a different word these comparisons fail, unlike a snapshot taken from the art
// itself.
const GLYPH_WIDTH = 4
const GLYPH_PITCH = GLYPH_WIDTH + 1

const EXPECTED_GLYPHS: Record<string, string[]> = {
  s: ["....", ".##.", "#...", ".##.", "...#", "###."],
  i: [".#..", "....", ".#..", ".#..", ".#..", ".#.."],
  l: [".#..", ".#..", ".#..", ".#..", ".#..", ".#.."],
  v: ["....", "#..#", "#..#", "#..#", "#..#", ".##."],
  e: ["....", ".##.", "#ss.", "####", "#ss.", ".##."],
  r: ["....", "###.", "#..#", "#...", "#...", "#..."],
  c: ["....", ".##.", "#ss.", "#ss.", "#ss.", ".##."],
  o: ["....", ".##.", "#ss#", "#ss#", "#ss#", ".##."],
  d: ["...#", ".###", "#ss#", "#ss#", "#ss#", ".###"],
}

const cellPixels = (char: string): [string, string] => {
  if (char === "█") return ["#", "#"]
  if (char === "▀") return ["#", "."]
  if (char === "▄") return [".", "#"]
  if (char === "_") return ["s", "s"]
  if (char === "^") return ["#", "s"]
  if (char === "~") return ["s", "."]
  return [".", "."]
}

// Pixel rows 0-7 for each template row pair, i.e. the half-cell grid.
const cellRows = (row: string) =>
  row.split("").reduce<[string[], string[]]>(
    ([top, bottom], char) => {
      const [upper, lower] = cellPixels(char)
      top.push(upper)
      bottom.push(lower)
      return [top, bottom]
    },
    [[], []],
  )

const pixelRows = (part: string[]) =>
  part.flatMap((row) => {
    const [top, bottom] = cellRows(row)
    return [top, bottom]
  })

const glyphPixels = (part: string[], letter: number) =>
  pixelRows(part).map((row) => row.slice(letter * GLYPH_PITCH, letter * GLYPH_PITCH + GLYPH_WIDTH).join(""))

test("wordmark spells silver plus code, glyph by glyph", () => {
  const word = "silvercode"
  const left = word.slice(0, 6)
  const right = word.slice(6)
  expect(left).toBe("silver")
  expect(right).toBe("code")
  for (const [letter, index] of Array.from(left).map((char, i) => [char, i] as const)) {
    // Pixel rows 1-6 are the letter body; row 0 is never drawn.
    expect(glyphPixels(logo.left, index).slice(1, 7)).toEqual(EXPECTED_GLYPHS[letter])
  }
  for (const [letter, index] of Array.from(right).map((char, i) => [char, i] as const)) {
    expect(glyphPixels(logo.right, index).slice(1, 7)).toEqual(EXPECTED_GLYPHS[letter])
  }
})
