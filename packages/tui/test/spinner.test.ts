import { expect, test } from "bun:test"
import { createColors, createFrames } from "../src/ui/spinner"

// The scanner head is the lead block: the rightmost active "■" in a forward
// frame, the leftmost in a reverse frame, and the column where the color
// generator returns its lead color.
const headColumn = (frame: string) => frame.lastIndexOf("■")

test("createFrames sweeps forward and wraps by default", () => {
  const frames = createFrames({ style: "blocks", color: "#ffffff" })

  // Preserve the original 54-frame cadence while never reversing direction.
  expect(frames).toHaveLength(54)
  expect(frames.map(headColumn)).toEqual(Array.from({ length: 54 }, (_, frame) => Math.floor((frame * 8) / 54)))
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

test("createColors keeps the scanner head at frame % cycle length across cycles", () => {
  const colors = createColors({ color: "#ffffff" })
  const frames = createFrames({ style: "blocks", color: "#ffffff" })
  const width = 8
  const cycleLength = frames.length
  const lead = colors(0, 0, cycleLength, width)

  // Drive frameIndex through three complete 54-frame cycles and ask for the
  // color at the actual head position of each corresponding frame.
  for (let frame = 0; frame < cycleLength * 3; frame++) {
    const head = headColumn(frames[frame % cycleLength])
    expect(colors(frame, head, cycleLength, width)).toEqual(lead)
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

test("forward-only loading indicator preserves the original 2.16s cadence", () => {
  // The original scanner had 54 frames at the existing 40ms consumer interval:
  // 8 forward + 9 hold + 7 reverse + 30 hold = 2160ms. The forward-only loop
  // now keeps the same 54-frame cadence while removing the reverse/hold phases.
  const interval = 40
  expect(createFrames().length * interval).toBe(2160)
})
