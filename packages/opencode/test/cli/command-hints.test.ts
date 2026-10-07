import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cliIt } from "../lib/cli-process"

// User-facing hints are the one place the product tells people what to type
// next, and a rename or a refactor can leave them describing a command that
// does not exist. Two such hints shipped in the alphacode→silvercode rename:
// `silvercode x @modelcontextprotocol/server-filesystem` (no `x` command) and
// `silvercode auth cloudflare-ai-gateway` (auth is an alias of `providers`, and
// its credential route is `auth login`). Nothing else catches that: yargs only
// validates what it is actually invoked with, and a typo'd hint fails at
// exactly the moment the user is already stuck.
//
// So read the hints out of the source, ask the real CLI what it documents, and
// require every hint to resolve against that surface.

const root = join(import.meta.dir, "..", "..")

// Files whose literals are rendered to users. `.txt` prompt files are excluded
// on purpose: their `silvercode` mentions are prose about the product, not
// commands to run.
const SOURCES = [
  "src/cli/cmd/mcp.ts",
  "src/mcp/index.ts",
  "src/cli/cmd/upgrade.ts",
  "src/cli/cmd/providers.ts",
  "src/cli/cmd/uninstall.ts",
  "src/cli/cmd/github.handler.ts",
  "src/cli/error.ts",
  "src/acp/service.ts",
  "src/provider/error.ts",
  "src/provider/provider.ts",
  "src/provider/qwen-web/plugin.ts",
  "src/installation/index.ts",
  "src/cli/factory-default.ts",
  "../tui/src/feature-plugins/home/tips-view.tsx",
]

// Deliberate invocation contexts: backticked spans, `{highlight}` spans, the
// `Run: silvercode …` prompts, and `e.g.` placeholders. Plain prose
// ("silvercode will capture…") would otherwise look like a command with
// arbitrary words after it.
const PATTERNS = [
  /`([^`\n]*silvercode [^`\n]*)`/g,
  /\{highlight\}([^{}\n]*silvercode [^{}\n]*)\{\/highlight\}/g,
  /(?<![A-Za-z])(?:Run|run|Use|use|Add|add|set|e\.g\.,?)\s*:?\s+(silvercode [a-z][^\n"`'{}]*)/g,
]

// Product prose that a "run this" pattern happens to catch. Each entry is a
// sentence, not an invocation; keeping the list explicit means a genuinely
// wrong command cannot hide in it by accident. Anything else that fails to
// resolve is a real bug.
const PROSE = [
  // An error message, not an instruction: the backtick span is the sentence.
  "failed. Note, silvercode does not support MCP authentication yet.",
]

const isProse = (text: string) => PROSE.some((sentence) => text.includes(sentence))

type Invocation = { file: string; text: string; words: string[] }

function invocations(): Invocation[] {
  const found: Invocation[] = []
  for (const file of SOURCES) {
    const source = readFileSync(join(root, file), "utf8")
    for (const pattern of PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const text = match[1]!.replace(/\s+/g, " ").trim()
        // Words only: a flag, `<placeholder>` or `${template}` ends the command
        // path (flags are validated by the help snapshots).
        const words: string[] = []
        for (const token of text.split(" ").slice(1)) {
          if (!/^[a-z][a-z0-9-]*$/.test(token)) break
          words.push(token)
        }
        if (words.length > 0 && words.length <= 3 && !isProse(text)) found.push({ file, text, words })
      }
    }
  }
  return found
}

// `  silvercode mcp add [name]     add an MCP server   [aliases: ls]`
const DOCUMENTED = /^\s+silvercode ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)\b(?![^[]*\[aliases:)/gm
const ALIAS = /\[aliases: ([^\]]+)\]/g

/// Every command path yargs documents in `help`. Aliases become extra paths so
/// `silvercode auth list` validates against `providers list [aliases: auth]`.
function documented(help: string): string[] {
  const paths: string[] = []
  for (const line of help.split("\n")) {
    const match = line.match(/^\s+silvercode ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)\b/)
    if (!match) continue
    const path = match[1]!
    paths.push(path)
    const aliases = line.match(/\[aliases: ([^\]]+)\]/)
    if (!aliases) continue
    const first = path.split(" ")[0]!
    for (const alias of aliases[1]!.split(",").map((x) => x.trim())) {
      paths.push(alias + path.slice(first.length))
    }
  }
  return paths
}

// `auth` is an alias of `providers`; asking the canonical command about its
// help covers both spellings (documented() expands the aliases back out).
function canonical(parent: string, help: string): string {
  for (const line of help.split("\n")) {
    const path = line.match(/^\s+silvercode ([a-z][a-z0-9-]*)\b/)
    if (!path) continue
    const aliases = line.match(/\[aliases: ([^\]]+)\]/)
    if (aliases?.[1]!.split(",").some((x) => x.trim() === parent)) return path[1]!
  }
  return parent
}

function resolves(paths: string[], words: string[]): boolean {
  const hint = words.join(" ")
  return paths.some((path) => path === hint || path.startsWith(hint + " "))
}

const HINTS = invocations()
const PARENTS = [...new Set(HINTS.map((h) => h.words[0]!))].sort()

describe("silvercode command hints", () => {
  cliIt.live(
    "every documented command path validates the hints in the source",
    ({ opencode }) =>
      Effect.gen(function* () {
        const parse = (text: string) =>
          text
            .split("\n")
            .filter((line) => /^\s+silvercode /.test(line))
            .join("\n")

        const help = parse((yield* opencode.spawn(["--help"], { env: { COLUMNS: "200" } })).stderr)
        const paths = documented(help)
        const failures: string[] = []

        // Subcommand surfaces: ask the CLI about each command the hints use.
        // Both spellings: the alias form is what the hints say (`auth login`),
        // the canonical form is what the top-level help documents.
        const parents = [...new Set([...PARENTS, ...PARENTS.map((parent) => canonical(parent, help))])].sort()
        const [subFailures, sub] = yield* Effect.partition(
          parents,
          (parent) => opencode.spawn([parent, "--help"], { env: { COLUMNS: "200" } }),
          { concurrency: 8 },
        )
        for (const [index, result] of sub.entries()) {
          if (result.exitCode !== 0) failures.push(`silvercode ${parents[index]} --help exited ${result.exitCode}`)
        }
        const subPaths = sub
          .flatMap((result) => (result.exitCode === 0 ? documented(result.stderr) : []))
        void subFailures

        const all = [...paths, ...subPaths]

        // Sanity: the help output we parse is real, and the negative controls
        // stay negative (otherwise this test would pass vacuously).
        for (const expected of ["mcp add", "providers login", "auth login", "agent create", "github install"]) {
          if (!resolves(all, expected.split(" "))) failures.push(`help is missing ${expected}`)
        }
        for (const bogus of ["x", "frobnicate"]) {
          if (resolves(all, [bogus])) failures.push(`help unexpectedly documents ${bogus}`)
        }
        for (const hint of HINTS) {
          if (!resolves(all, hint.words)) {
            failures.push(`${hint.file}: \`${hint.text}\` → no \`silvercode ${hint.words.join(" ")}\` command`)
          }
        }

        if (failures.length > 0) {
          throw new Error(`unresolvable silvercode command hints:\n  ${failures.join("\n  ")}`)
        }
      }),
    180_000,
  )

  test("the MCP debug probe announces itself as silvercode", () => {
    // `mcp debug` sends its own client name to third-party servers, so this
    // string is externally visible. It was left as "opencode-debug" (upstream's
    // name) through the rename.
    const source = readFileSync(join(root, "src/cli/cmd/mcp.ts"), "utf8")
    const names = [...source.matchAll(/name: "([a-z-]+-debug)"/g)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThanOrEqual(2)
    expect(names.every((name) => name.startsWith("silvercode"))).toBe(true)
    expect(source).not.toContain("opencode-debug")
  })

  test("the scan still sees the hints it is meant to guard", () => {
    // Part of the contract: if a rename moves these files, the hints silently
    // stop being checked, so fail when the list dries up.
    const seen = HINTS.map((hint) => hint.words.join(" "))
    for (const expected of [
      "mcp auth",
      "auth login",
      "auth list",
      "agent create",
      "github install",
      "upgrade",
      "serve",
    ]) {
      expect(seen).toContain(expected)
    }
  })
})
