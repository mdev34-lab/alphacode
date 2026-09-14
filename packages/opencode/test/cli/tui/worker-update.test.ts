import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const workerSource = readFileSync(fileURLToPath(new URL("../../../src/cli/tui/worker.ts", import.meta.url)), "utf8")

test("TUI worker does not trigger upstream OpenCode update checks", () => {
  expect(workerSource).not.toContain('import { upgrade } from "@/cli/upgrade"')
  expect(workerSource).not.toContain("checkUpgrade")
})
