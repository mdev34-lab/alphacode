import { expect, test } from "bun:test"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"

test("match nested and non-nested", () => {
  expect(Ignore.match("node_modules/index.js")).toBe(true)
  expect(Ignore.match("node_modules")).toBe(true)
  expect(Ignore.match("node_modules/")).toBe(true)
  expect(Ignore.match("node_modules/bar")).toBe(true)
  expect(Ignore.match("node_modules/bar/")).toBe(true)
})

test("folder globs cover known generated and dependency directories", () => {
  expect(Ignore.FOLDER_GLOBS).toContain("**/node_modules")
  expect(Ignore.FOLDER_GLOBS).toContain("**/.git")
  expect(Ignore.FOLDER_GLOBS).toContain("**/dist")
  expect(Ignore.FOLDER_GLOBS).toContain("**/build")
  expect(Ignore.FOLDER_GLOBS).toContain("**/__pycache__")
  expect(Ignore.FOLDER_GLOBS).toContain("**/.cache")
})
