import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PASTE_FILE_DIRECTORY, PASTE_INLINE_MAX_BYTES, pasteFilePath, pastePreview, writePasteFile } from "../../src/session/paste-file"

function fakeFsys(write: (file: string, content: string) => Effect.Effect<void, Error>): FSUtil.Interface {
  const fsys = {
    writeWithDirs: (file: string, content: string | Uint8Array) => write(file, String(content)),
  }
  return fsys as unknown as FSUtil.Interface
}

describe("pasteFilePath", () => {
  test("places paste files in the managed attachment directory", () => {
    expect(pasteFilePath("ses_1", "abc")).toBe(path.join(Global.Path.data, PASTE_FILE_DIRECTORY, "ses_1", "paste-abc.txt"))
  })
})

describe("pastePreview", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `preview line ${i} with some words to bulk it up`)
  const content = lines.join("\n")
  const preview = pastePreview(content, "/tmp/paste.txt")

  test("stays within the inline byte budget", () => {
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(PASTE_INLINE_MAX_BYTES)
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(PASTE_INLINE_MAX_BYTES)
  })

  test("keeps the head and tail of the content with a marker in between", () => {
    expect(preview).toContain("... content truncated; full content saved to /tmp/paste.txt ...")
    expect(preview.startsWith(lines[0])).toBe(true)
    expect(preview.endsWith(lines[lines.length - 1])).toBe(true)
    const [head, tail] = preview.split("... content truncated; full content saved to /tmp/paste.txt ...")
    expect(Buffer.byteLength(head, "utf8")).toBeLessThan(PASTE_INLINE_MAX_BYTES / 2)
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThan(PASTE_INLINE_MAX_BYTES / 2)
  })

  test("does not split multibyte characters at the budget boundary", () => {
    const unicode = "文".repeat(20_000) // 60KB in UTF-8
    const value = pastePreview(unicode, "/tmp/paste.txt")
    const marker = "content truncated"
    expect(value).toContain(marker)
    const [head, tail] = value.split(marker)
    // Every character taken must be a whole CJK character.
    expect(/文+/.test(head.trim())).toBe(true)
    expect(/文+/.test(tail.trim())).toBe(true)
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(PASTE_INLINE_MAX_BYTES)
  })
})

describe("writePasteFile", () => {
  test("returns the managed file path on success", async () => {
    let written: [string, string] | undefined
    const fsys = fakeFsys((file, content) => {
      written = [file, content]
      return Effect.void
    })
    const file = await Effect.runPromise(writePasteFile(fsys, "ses_1", "id1", "hello"))
    expect(file).toBe(path.join(Global.Path.data, PASTE_FILE_DIRECTORY, "ses_1", "paste-id1.txt"))
    expect(written?.[1]).toBe("hello")
  })

  test("falls back to undefined when the write fails instead of throwing", async () => {
    const fsys = fakeFsys(() => Effect.fail(new Error("disk full")))
    const file = await Effect.runPromise(writePasteFile(fsys, "ses_1", "id1", "hello"))
    expect(file).toBeUndefined()
  })
})
