import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { HELP_SECTIONS } from "../src/ui/help-content"

// The /help dialog is a curated editorial overview, NOT an exhaustive command
// reference (the command palette is authoritative). But a curated list still
// must not advertise commands that no longer exist — otherwise /help drifts
// stale while the palette stays correct.
//
// The TUI's slash commands are registered as string literals across a handful
// of files (app.tsx, the prompt component, the session routes, the diff-viewer
// plugin), and two more (`init`, `review`) come from the server command store.
// This test scans those files for the literal slash-name strings, so a rename
// or removal of a registered command shows up here — without maintaining a
// second, hand-written registry that would itself go stale. It deliberately
// avoids booting the renderer, so it stays lightweight.
const TUI_SRC = path.join(import.meta.dir, "..", "src")

const SLASH_FILES = [
  path.join(TUI_SRC, "app.tsx"),
  path.join(TUI_SRC, "component", "prompt", "index.tsx"),
  path.join(TUI_SRC, "routes", "session", "index.tsx"),
  path.join(TUI_SRC, "feature-plugins", "system", "diff-viewer.tsx"),
]

// Collect slash-command names from a TUI source file.
//   - app.tsx / prompt / diff-viewer use  `slashName: "name"`.
//   - routes/session uses             `slash: { name: "name" }`.
function slashNames(file: string): Set<string> {
  const src = readFileSync(file, "utf8")
  const names = new Set<string>()
  for (const match of src.matchAll(/slashName:\s*"([^"]+)"/g)) names.add(match[1])
  for (const match of src.matchAll(/slash:\s*\{\s*name:\s*"([^"]+)"/g)) names.add(match[1])
  return names
}

// `init` and `review` are server-side commands loaded from the command store
// (packages/opencode), not TUI `slashName` registrations. Their names come from
// the `Default` constants in the server command module.
function serverCommandNames(): Set<string> {
  const file = path.join(import.meta.dir, "..", "..", "opencode", "src", "command", "index.ts")
  const src = readFileSync(file, "utf8")
  const names = new Set<string>()
  for (const match of src.matchAll(/\b(?:INIT|REVIEW):\s*"([a-z0-9_-]+)"/g)) names.add(match[1])
  return names
}

test("every curated help command is a registered slash command", () => {
  const registered = new Set<string>()
  for (const file of SLASH_FILES) for (const name of slashNames(file)) registered.add(name)
  for (const name of serverCommandNames()) registered.add(name)

  const curated = HELP_SECTIONS.flatMap((section) => section.commands.map((command) => command.command.replace(/^\//, "")))
  expect(curated.length).toBeGreaterThan(0)
  for (const command of curated) {
    expect(registered.has(command), `/help advertises a slash command that is not registered: /${command}`).toBe(true)
  }
})
