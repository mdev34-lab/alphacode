/**
 * Regression tests for the narration-only shell-command detector.
 *
 * See packages/core/src/tool/narration.ts for the specification.
 */

import { describe, expect, test } from "bun:test"
import { NarrationDetector } from "@opencode-ai/core/tool/narration"

// ---------------------------------------------------------------------------
// 1. Narration-only commands — detector must fire
// ---------------------------------------------------------------------------

describe("isNarrationOnly — narration patterns that should be detected", () => {
  const cases: [string, string][] = [
    // echo — double-quoted
    ['echo "Calling session_list"', "echo double-quoted Calling"],
    ['echo "calling session_list"', "echo lower-case calling"],
    ['echo "Using devin_session_search tool instead"', "echo Using"],
    ['echo "using devin_session_search"', "echo lower-case using"],
    ['echo "trying devin_session_search"', "echo trying"],
    ['echo "Trying devin_session_search"', "echo Trying title-case"],
    ['echo "Searching for results"', "echo Searching with trailing words"],
    ['echo "searching for results"', "echo lower-case searching with trailing words"],
    ['echo "searching"', "echo bare searching — exact word match"],
    ['echo "I will use the search tool"', "echo I will"],
    ['echo "I am calling the tool"', "echo I am"],
    [`echo "I'm fetching the data"`, "echo I'm"],
    ['echo "Executing the tool"', "echo Executing"],
    ['echo "Invoking the API"', "echo Invoking"],
    ['echo "Fetching the data"', "echo Fetching"],
    // echo — single-quoted
    ["echo 'Calling session_list'", "echo single-quoted Calling"],
    ["echo 'Using tool_name'", "echo single-quoted Using"],
    // printf — trivial single-argument form only
    ['printf "Calling session_list"', "printf single-arg double-quoted Calling"],
    ["printf 'Using tool_name'", "printf single-arg single-quoted Using"],
    // Write-Output (PowerShell) — case-insensitive
    ['Write-Output "Calling session_list"', "Write-Output Calling"],
    ['write-output "Using tool"', "write-output lower-case"],
    // Leading whitespace on the full command
    ['  echo "Calling foo"', "leading whitespace stripped"],
  ]

  for (const [command, label] of cases) {
    test(label, () => {
      expect(NarrationDetector.isNarrationOnly(command)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Legitimate shell output — detector must NOT fire
// ---------------------------------------------------------------------------

describe("isNarrationOnly — legitimate shell commands that must not be flagged", () => {
  const cases: [string, string][] = [
    // ── Variable expansions ───────────────────────────────────────────────
    ['echo "$PATH"', "variable expansion $PATH"],
    ['echo "${HOME}"', "brace variable ${HOME}"],
    ["printf '%s\\n' \"$result\"", "printf with variable arg"],
    ["echo $VAR", "bare unquoted variable"],

    // ── Sub-shell expressions ─────────────────────────────────────────────
    ['echo "$(date)"', "sub-shell $(...) in double quotes"],

    // ── Shell operators ───────────────────────────────────────────────────
    ['echo \'{"foo":"bar"}\' > file.json', "redirect > to file"],
    ["echo hello | grep hello", "pipe |"],
    ["echo foo; echo bar", "semicolon ;"],
    ["echo foo && echo bar", "&& operator"],
    ["echo foo || echo bar", "|| operator"],

    // ── No narration prefix ───────────────────────────────────────────────
    ["echo hello", "echo plain single word"],
    ["echo 'hello world'", "echo plain quoted string"],
    ['echo "Done"', "Done — not a narration verb"],
    ['echo "Error: file not found"', "error message"],
    ['echo "Build complete"', "build status"],
    ['echo "Success"', "Success — not a narration verb"],

    // ── printf — format + additional arguments must never fire ────────────
    // This is the main regression from the PR review: the old code concatenated
    // all args and would match "Calling %s session_list" as a narration prefix.
    ['printf "Calling %s" foo', "printf format + one positional arg"],
    ['printf "Calling %s\\n" foo', "printf format + newline escape + arg"],
    ['printf "Calling %s %s" foo bar', "printf format + two positional args"],
    ['printf "%s" "hello"', "printf plain format string"],
    ['printf "hello\\n"', "printf plain non-narration single arg"],

    // ── searching word-boundary cases ────────────────────────────────────
    // "searching" has no trailing space in isolation, so the exact-word check
    // must not fire on words that merely start with "searching".
    ['echo "searchingXYZ"', "searchingXYZ — prefix run-on must not fire"],
    ['echo "searchingly"', "searchingly — adverb form must not fire"],

    // ── Ambiguous prefixes removed from the list ──────────────────────────
    // "running", "sending", "getting" were dropped because they appear in too
    // many legitimate log lines (e.g. "Running tests", "Sending packet",
    // "Getting coffee"). The detector is now tighter on these.
    ['echo "Running tests"', "Running tests — not flagged (running removed from prefixes)"],
    ['echo "Sending request"', "Sending request — not flagged (sending removed)"],
    ['echo "Getting coffee"', "Getting coffee — not flagged (getting removed)"],

    // ── Non-print commands ────────────────────────────────────────────────
    ["ls -la", "ls command"],
    ["git status", "git status"],
    ["cat README.md", "cat"],
  ]

  for (const [command, label] of cases) {
    test(label, () => {
      expect(NarrationDetector.isNarrationOnly(command)).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. GUIDANCE constant — sanity checks
// ---------------------------------------------------------------------------

describe("GUIDANCE constant", () => {
  test("is non-empty", () => {
    expect(NarrationDetector.GUIDANCE.length).toBeGreaterThan(0)
  })

  test("contains the AlphaCode marker so the model can identify the harness as source", () => {
    expect(NarrationDetector.GUIDANCE).toContain("[AlphaCode]")
  })

  test("advises using the appropriate tool directly", () => {
    expect(NarrationDetector.GUIDANCE.toLowerCase()).toContain("tool")
  })
})
