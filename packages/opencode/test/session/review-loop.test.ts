import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/session/prompt")

const readPrompt = (name: string) => readFile(path.join(directory, name), "utf8")

describe("mandatory review loop prompt contract", () => {
  test("requires a review after work that follows review findings", async () => {
    const prompt = await readPrompt("review-loop.txt")

    expect(prompt).toContain("WORK → REVIEW → APPROVED → FINISH")
    expect(prompt).toContain("NEEDS FIXES → WORK → REVIEW")
    expect(prompt).toContain("After every Work pass performed in response to review findings, dispatch Review again")
    expect(prompt).toContain("Only after an explicit `Approved` review may you call `finish`")
    expect(prompt).toContain("review-cap")
  })

  test("finish nudge preserves the review gate", async () => {
    const nudge = await readPrompt("finish-nudge.txt")

    expect(nudge).toContain("outstanding `Needs fixes` verdict")
    expect(nudge).toContain("dispatch the read-only `review` subagent again")
    expect(nudge).toContain("explicit `Approved` verdict")
  })
})
