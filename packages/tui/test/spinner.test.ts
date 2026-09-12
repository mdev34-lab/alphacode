import { expect, test } from "bun:test"
import { createColors, createFrames } from "../src/ui/spinner"

// The scanner head is the lead block: the rightmost active "■" in a forward
// frame, the leftmost in a reverse frame, and the column where the color
// generator returns its lead color.
const headColumn = (frame: string) => frame.lastIndexOf("■")

test("createFrames sweeps forward and wraps by default", () => {
  const frames = createFrames({ style: "blocks", color: "#ffffff" })

  // One frame per column: a forward wrap has no hold or reverse frames.
  expect(frames).toHaveLength(8)
  expect(frames.map(headColumn)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
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
  expect(frames.slice(0, width).map(headColumn)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

  // Hold at end: head stays at the last column.
  expect(frames.slice(width, width + holdEnd).every((frame) => headColumn(frame) === width - 1)).toBe(true)

  // Reverse: head returns one column per frame toward the start.
  expect(frames.slice(width + holdEnd, width + holdEnd + (width - 1)).map((frame) => frame.indexOf("■"))).toEqual([
    6, 5, 4, 3, 2, 1, 0,
  ])

  // Hold at start: head stays at the first column.
  expect(frames.slice(width + holdEnd + (width - 1)).every((frame) => frame.indexOf("■") === 0)).toBe(true)
})

test("createColors keeps the scanner head at frame % width across cycles", () => {
  const colors = createColors({ color: "#ffffff" })
  const width = 8
  const lead = colors(0, 0, width, width)

  // Drive frameIndex past one full cycle so the `frameIndex % totalChars` wrap
  // inside getScannerState is exercised (not just the first sweep).
  for (let frame = 0; frame < width * 3; frame++) {
    expect(colors(frame, frame % width, width, width)).toEqual(lead)
  }
})

test("frames and colors agree on the scanner head", () => {
  const options = { style: "blocks", color: "#ffffff" } as const
  const frames = createFrames(options)
  const colors = createColors(options)
  const width = frames[0].length
  const lead = colors(0, 0, frames.length, width)

  // The spinner renders `frames[i]` and colors each character with
  // `colors(i, column, frames.length, width)`. Assert the head block in the
  // frame text is the column that receives the lead color, across cycles.
  for (let frame = 0; frame < frames.length * 3; frame++) {
    const head = frames[frame % frames.length].lastIndexOf("■")
    expect(colors(frame, head, frames.length, width)).toEqual(lead)
  }
})
