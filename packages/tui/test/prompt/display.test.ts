import { describe, expect, test } from "bun:test"
import {
  displayCharAt,
  displaySlice,
  displayWidth,
  mentionTriggerIndex,
  truncateDisplay,
  truncateDisplayMiddle,
  truncateDisplayTail,
} from "../../src/prompt/display"

describe("prompt display", () => {
  test("truncates by terminal columns without splitting CJK, emoji, or combining graphemes", () => {
    const cjk = "界".repeat(30)
    const emoji = "👨‍👩‍👧‍👦"
    const combining = "e\u0301"

    expect(displayWidth(cjk)).toBe(60)
    expect(truncateDisplay(cjk, 50)).toBe("界".repeat(24) + "…")
    expect(truncateDisplay(emoji.repeat(3) + "x", 5)).toBe(emoji.repeat(2) + "…")
    expect(truncateDisplay(combining.repeat(4), 3)).toBe(combining.repeat(2) + "…")

    const path = truncateDisplayMiddle("/a/b/c/d", 5)
    expect(path).toBe("/a…/d")
    expect(displayWidth(path)).toBeLessThanOrEqual(5)
    expect(truncateDisplayTail("/a/long-project-directory-name", 9)).toBe("…ory-name")
  })

  test("uses display-width offsets for mentions", () => {
    expect(mentionTriggerIndex("@")).toBe(0)
    expect(mentionTriggerIndex("test @")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("こんにちは @")).toBe(11)
    expect(mentionTriggerIndex("한국어 @")).toBe(7)
    expect(mentionTriggerIndex("🙂 @")).toBe(3)
    expect(mentionTriggerIndex("中文 @src file", Bun.stringWidth("中文 @src"))).toBe(5)
    expect(displayCharAt("中文 @src", Bun.stringWidth("中文 @"))).toBe("s")
    expect(displaySlice("中文 @src", 5, Bun.stringWidth("中文 @src"))).toBe("@src")
    expect(displaySlice("中文 @src", 6, Bun.stringWidth("中文 @src"))).toBe("src")
    expect(mentionTriggerIndex("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe(3)
    expect(displayCharAt("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @"))).toBe("s")
    expect(displaySlice("👨‍👩‍👧‍👦 @src", 3, Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe("@src")
    expect(mentionTriggerIndex("@file1\n@file2", 13)).toBe(7)
    expect(displayCharAt("@file1\n@file2", 6)).toBe("\n")
    expect(displaySlice("@file1\n@file2", 8, 13)).toBe("file2")
    expect(mentionTriggerIndex("@file1\nfoo @file2", 17)).toBe(11)
    expect(mentionTriggerIndex("中文 @one\n@two", 14)).toBe(10)
    expect(displaySlice("中文 @one\n@two", 11, 14)).toBe("two")
    expect(mentionTriggerIndex("中文@")).toBeUndefined()
    expect(mentionTriggerIndex("こんにちは@")).toBeUndefined()
    expect(mentionTriggerIndex("한국어@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("foo@bar.com")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @src file")).toBeUndefined()
  })
})
