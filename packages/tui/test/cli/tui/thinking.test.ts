import { describe, expect, test } from "bun:test"
import { reasoningOpen, reasoningSummary } from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })
})

describe("reasoningOpen", () => {
  test("keeps the block open while the reasoning stream is active, in every mode", () => {
    // The reasoning stream has not ended yet (`done` false) — the block must stay
    // open so the streamed chain-of-thought remains readable, regardless of the
    // display mode or whether the user manually expanded it.
    expect(reasoningOpen({ done: false, mode: "hide", expanded: false })).toBe(true)
    expect(reasoningOpen({ done: false, mode: "hide", expanded: true })).toBe(true)
    expect(reasoningOpen({ done: false, mode: "show", expanded: false })).toBe(true)
  })

  test("transitions to the mode default only once the reasoning stream ends", () => {
    // Once `done`, the block follows the mode default: hide collapses it unless
    // the user expanded it manually, show keeps it open.
    expect(reasoningOpen({ done: true, mode: "hide", expanded: false })).toBe(false)
    expect(reasoningOpen({ done: true, mode: "hide", expanded: true })).toBe(true)
    expect(reasoningOpen({ done: true, mode: "show", expanded: false })).toBe(true)
    expect(reasoningOpen({ done: true, mode: "show", expanded: true })).toBe(true)
  })

  test("a manual expand in hide mode survives the completed transition", () => {
    // The user clicked to open the collapsed block while reasoning finished.
    expect(reasoningOpen({ done: true, mode: "hide", expanded: true })).toBe(true)
  })
})
