import { describe, expect, test } from "bun:test"
import {
  LARGE_PASTE_BREAKS,
  LARGE_PASTE_CHARS,
  LARGE_PASTE_FILE_BYTES,
  isLargePaste,
  isPasteAsFile,
  pastedFilePart,
  pastedFilePlaceholder,
} from "../../src/prompt/paste"

describe("isLargePaste", () => {
  test("tiny single-line paste is not large", () => {
    expect(isLargePaste("Hello")).toBe(false)
  })

  test("ordinary paragraph is not large", () => {
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(6)
    expect(isLargePaste(paragraph)).toBe(false)
  })

  test("multi-paragraph paste under the thresholds is not large", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with a few words of content.`).join("\n")
    expect(text.length < LARGE_PASTE_CHARS).toBe(true)
    expect(isLargePaste(text)).toBe(false)
  })

  test("paste at the character threshold is large", () => {
    expect(isLargePaste("a".repeat(LARGE_PASTE_CHARS))).toBe(true)
  })

  test("paste one character below the threshold with few breaks is not large", () => {
    // Spread the characters over a couple of lines so the break count stays tiny.
    const text = "a".repeat(Math.floor((LARGE_PASTE_CHARS - 1) / 2)) + "\n" + "b".repeat(Math.floor((LARGE_PASTE_CHARS - 1) / 2) - 1)
    expect(text.length).toBeLessThan(LARGE_PASTE_CHARS)
    expect(isLargePaste(text)).toBe(false)
  })

  test("paste at the line-break threshold is large", () => {
    // LARGE_PASTE_BREAKS line breaks means LARGE_PASTE_BREAKS + 1 lines.
    const text = Array.from({ length: LARGE_PASTE_BREAKS + 1 }, (_, i) => `line ${i}`).join("\n")
    expect(text.length < LARGE_PASTE_CHARS).toBe(true)
    expect(isLargePaste(text)).toBe(true)
  })

  test("paste one break below the threshold is not large", () => {
    // One fewer break than the threshold: LARGE_PASTE_BREAKS - 1 breaks.
    const text = Array.from({ length: LARGE_PASTE_BREAKS }, (_, i) => `line ${i}`).join("\n")
    expect(text.length < LARGE_PASTE_CHARS).toBe(true)
    expect(isLargePaste(text)).toBe(false)
  })

  test("very long single-line paste is large by character count", () => {
    expect(isLargePaste("x".repeat(50_000))).toBe(true)
  })

  test("unicode text does not trip the threshold on UTF-8 byte size", () => {
    // 4000 CJK characters are 12KB in UTF-8 but only 4000 in string length,
    // so a normal-sized unicode paragraph must not be classified as large.
    expect(isLargePaste("文".repeat(4000))).toBe(false)
    // 8000 characters crosses the threshold.
    expect(isLargePaste("文".repeat(LARGE_PASTE_CHARS))).toBe(true)
  })

  test("empty text is not large", () => {
    expect(isLargePaste("")).toBe(false)
  })

  test("Wikipedia-like article is large", () => {
    const article = Array.from({ length: 400 }, (_, i) => `Section ${i}. ${"Wikipedia-like prose content of a reasonable length. ".repeat(4)}`).join("\n\n")
    expect(article.length).toBeGreaterThan(LARGE_PASTE_CHARS)
    expect(isLargePaste(article)).toBe(true)
  })
})

describe("pastedFilePlaceholder", () => {
  test("uses the bracketed file counter convention", () => {
    expect(pastedFilePlaceholder(1)).toBe("[Pasted file 1]")
    expect(pastedFilePlaceholder(2)).toBe("[Pasted file 2]")
  })
})

describe("pastedFilePart", () => {
  test("builds a text/plain data-url file part that round-trips the payload", () => {
    const text = "Hello\n\n" + "a".repeat(9000)
    const part = pastedFilePart({ text, index: 1, start: 0, end: 14 })
    expect(part.type).toBe("file")
    expect(part.mime).toBe("text/plain")
    expect(part.filename).toBe("paste-1.txt")
    const match = part.url.match(/^data:text\/plain;base64,(.+)$/)
    expect(match).not.toBeNull()
    expect(Buffer.from(match![1], "base64").toString("utf8")).toBe(text)
    expect(part.source).toEqual({
      type: "file",
      path: "",
      text: { start: 0, end: 14, value: "[Pasted file 1]" },
    })
  })

  test("preserves unicode payloads through the base64 round trip", () => {
    const text = "über-fine café — 日本語 — 🎉".repeat(500)
    const part = pastedFilePart({ text, index: 3, start: 5, end: 20 })
    const payload = part.url.split(",")[1]
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(text)
    expect(part.filename).toBe("paste-3.txt")
    expect(part.source?.text.value).toBe("[Pasted file 3]")
  })

  test("numbers repeated pasted files within a draft", () => {
    expect(pastedFilePart({ text: "x", index: 1, start: 0, end: 1 }).filename).toBe("paste-1.txt")
    expect(pastedFilePart({ text: "x", index: 2, start: 0, end: 1 }).filename).toBe("paste-2.txt")
  })
})

describe("isPasteAsFile", () => {
  test("small paste is not a file", () => {
    expect(isPasteAsFile("Hello")).toBe(false)
  })

  test("ordinary paragraph under the file threshold is not a file", () => {
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(6)
    expect(paragraph.length).toBeLessThan(LARGE_PASTE_FILE_BYTES)
    expect(isPasteAsFile(paragraph)).toBe(false)
  })

  test("medium paste (2KB+) is a file even with few line breaks", () => {
    const text = "x".repeat(LARGE_PASTE_FILE_BYTES)
    expect(text.length).toBeLessThan(LARGE_PASTE_CHARS)
    expect(isLargePaste(text)).toBe(false)
    expect(isPasteAsFile(text)).toBe(true)
  })

  test("medium paste at exactly the file threshold is a file", () => {
    expect(isPasteAsFile("a".repeat(LARGE_PASTE_FILE_BYTES))).toBe(true)
  })

  test("paste one byte below the file threshold is not a file", () => {
    const text = "a".repeat(LARGE_PASTE_FILE_BYTES - 1)
    expect(text.length).toBeLessThan(LARGE_PASTE_FILE_BYTES)
    expect(isPasteAsFile(text)).toBe(false)
  })

  test("definitely-large pastes (isLargePaste) are still files", () => {
    expect(isPasteAsFile("a".repeat(LARGE_PASTE_CHARS))).toBe(true)
    const text = Array.from({ length: LARGE_PASTE_BREAKS + 1 }, (_, i) => `line ${i}`).join("\n")
    expect(isPasteAsFile(text)).toBe(true)
  })

  test("unicode: 2KB of CJK characters is a file", () => {
    const text = "文".repeat(LARGE_PASTE_FILE_BYTES)
    expect(text.length).toBeLessThan(LARGE_PASTE_CHARS)
    // 2048 CJK characters are 6144 bytes in UTF-8, well above 2KB byte threshold.
    expect(Buffer.byteLength(text, "utf-8")).toBe(LARGE_PASTE_FILE_BYTES * 3)
    expect(isPasteAsFile(text)).toBe(true)
  })

  test("regression: 5KB paste of code is a file (user-reported case)", () => {
    // 50 lines × ~100 chars each = ~5KB total. Under 8KB chars and under
    // 120 line breaks, so the historical isLargePaste returns false even
    // though the content is clearly "large" by user perception.
    const text = Array.from({ length: 50 }, (_, i) => `// step ${i}: ${"x".repeat(60)}`).join("\n")
    expect(text.length).toBeGreaterThan(LARGE_PASTE_FILE_BYTES)
    expect(text.length).toBeLessThan(LARGE_PASTE_CHARS)
    expect(isLargePaste(text)).toBe(false)
    expect(isPasteAsFile(text)).toBe(true)
  })

  test("empty text is not a file", () => {
    expect(isPasteAsFile("")).toBe(false)
  })
})
