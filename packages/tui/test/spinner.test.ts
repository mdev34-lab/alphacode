import { expect, test } from "bun:test"
import { RGBA, type ColorInput } from "@opentui/core"
import { createColors, createFrames } from "../src/ui/spinner"

// For a forward sweep the scanner head is the rightmost active block ("■");
// for a backward sweep it is the leftmost. Both are exercised below.
const headColumnForward = (frame: string) => frame.lastIndexOf("■")
const headColumnBackward = (frame: string) => frame.indexOf("■")

// ColorGenerator returns ColorInput (string | RGBA); normalize so alpha is readable.
const alpha = (color: ColorInput) => (color instanceof RGBA ? color.a : RGBA.fromHex(color).a)

test("createFrames sweeps forward and wraps by default", () => {
  const frames = createFrames({ style: "blocks", color: "#ffffff" })

  // One frame per column: a forward wrap has no hold or reverse frames.
  expect(frames).toHaveLength(8)

  // The head advances one column per frame, never reversing direction.
  expect(frames.map(headColumnForward)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test("createFrames backward sweeps right-to-left", () => {
  const frames = createFrames({ style: "blocks", color: "#ffffff", direction: "backward" })

  expect(frames).toHaveLength(8)
  expect(frames.map(headColumnBackward)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
})

test("createFrames bidirectional reverses and holds at each end", () => {
  const holdEnd = 2
  const holdStart = 3
  const frames = createFrames({
    style: "blocks",
    color: "#ffffff",
    direction: "bidirectional",
    holdEnd,
    holdStart,
  })

  const width = 8
  // Forward sweep + hold at end + reverse sweep + hold at start.
  expect(frames.length).toBe(width + holdEnd + (width - 1) + holdStart)

  // Forward: head advances to the far end.
  expect(frames.slice(0, width).map(headColumnForward)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

  // Hold at end: head stays at the last column.
  expect(frames.slice(width, width + holdEnd).every((frame) => headColumnForward(frame) === width - 1)).toBe(true)

  // Reverse: head returns one column per frame toward the start.
  expect(frames.slice(width + holdEnd, width + holdEnd + (width - 1)).map(headColumnBackward)).toEqual([
    6, 5, 4, 3, 2, 1, 0,
  ])

  // Hold at start: head stays at the first column.
  expect(frames.slice(width + holdEnd + (width - 1)).every((frame) => headColumnBackward(frame) === 0)).toBe(true)
})

test("createColors wraps the brightest column across multiple cycles", () => {
  const colors = createColors({ color: "#ffffff" })
  const width = 8

  // Drive frameIndex past one full cycle so the `frameIndex % totalChars` wrap
  // inside getScannerState is exercised (not just the first sweep).
  for (let frame = 0; frame < width * 3; frame++) {
    let brightest = 0
    let maxAlpha = -1
    for (let column = 0; column < width; column++) {
      const a = alpha(colors(frame, column, width, width))
      if (a > maxAlpha) {
        maxAlpha = a
        brightest = column
      }
    }

    expect(brightest).toBe(frame % width)
  }
})
