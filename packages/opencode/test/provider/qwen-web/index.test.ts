import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { isQwenWebAuthRecord, QWEN_WEB_ID, shouldAutoloadQwenWeb } from "@/provider/qwen-web/index"

const savedEnv = { ...process.env }
let tmpdirs: string[] = []

afterEach(() => {
  process.env = { ...savedEnv }
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpdirs = []
})

describe("auth record and autoload gate", () => {
  test("provider id", () => {
    expect(QWEN_WEB_ID).toBe("qwen-web")
  })

  test("isQwenWebAuthRecord matches the login marker only", () => {
    expect(isQwenWebAuthRecord({ type: "api", key: "qwen-web-browser-session" })).toBe(true)
    expect(isQwenWebAuthRecord({ type: "api", key: "something-else" })).toBe(false)
    expect(isQwenWebAuthRecord({ type: "oauth" })).toBe(false)
    expect(isQwenWebAuthRecord(undefined)).toBe(false)
  })

  test("autoload requires setup evidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-index-"))
    tmpdirs.push(dir)
    process.env["QWEN_WEB_PROFILE_DIR"] = dir

    expect(shouldAutoloadQwenWeb({ auth: undefined, hasConfig: false })).toBe(false)
    expect(shouldAutoloadQwenWeb({ auth: undefined, hasConfig: true })).toBe(true)
    expect(shouldAutoloadQwenWeb({ auth: { type: "api", key: "qwen-web-browser-session" }, hasConfig: false })).toBe(
      true,
    )
    expect(shouldAutoloadQwenWeb({ auth: { type: "api", key: "other" }, hasConfig: false })).toBe(false)

    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ version: 1, authenticated: true }), "utf8")
    expect(shouldAutoloadQwenWeb({ auth: undefined, hasConfig: false })).toBe(true)
  })
})
