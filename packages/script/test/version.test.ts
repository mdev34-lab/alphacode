import { describe, expect, test } from "bun:test"
import {
  bumpVersion,
  classify,
  devVersion,
  formatNotes,
  nextVersion,
  NoReleasableChangesError,
  parseVersion,
  toChange,
  type Change,
  type Commit,
} from "../src/version"

const sha = "1af5cf384aa3175aaca6e0fb7ce5279dc4bef8c3"
const commit = (subject: string, body = ""): Commit => ({ sha, subject, body })

function change(type: string, options: Partial<Change> = {}): Change {
  return {
    type,
    description: "change",
    breaking: false,
    sha,
    ...options,
  }
}

describe("toChange", () => {
  const cases: Array<{ name: string; input: Commit; expected: Change | null }> = [
    {
      name: "parses a scoped feature",
      input: commit("feat(tui): add x"),
      expected: { type: "feat", scope: "tui", description: "add x", breaking: false, sha },
    },
    {
      name: "parses a fix without a scope",
      input: commit("fix: y"),
      expected: { type: "fix", description: "y", breaking: false, sha },
    },
    {
      name: "parses a breaking change marker",
      input: commit("feat(api)!: z"),
      expected: { type: "feat", scope: "api", description: "z", breaking: true, sha },
    },
    {
      name: "detects a BREAKING CHANGE footer",
      input: commit("feat(api): change endpoint", "BREAKING CHANGE: the old endpoint was removed"),
      expected: { type: "feat", scope: "api", description: "change endpoint", breaking: true, sha },
    },
    {
      name: "extracts a PR number and strips its suffix",
      input: commit("fix(tui): preserve pasted local file paths (#180)"),
      expected: {
        type: "fix",
        scope: "tui",
        description: "preserve pasted local file paths",
        breaking: false,
        pr: 180,
        sha,
      },
    },
    {
      name: "uses the last PR number and removes every suffix",
      input: commit("fix: support multiple references (#176) (#177)"),
      expected: { type: "fix", description: "support multiple references", breaking: false, pr: 177, sha },
    },
    {
      name: "parses the first conventional body line of a merge commit",
      input: commit(
        "Merge pull request #184 from owner/feature",
        "\nfeat(opencode): split Work and Code agents\n\nSome details",
      ),
      expected: {
        type: "feat",
        scope: "opencode",
        description: "split Work and Code agents",
        breaking: false,
        pr: 184,
        sha,
      },
    },
    {
      name: "ignores non-conventional subjects",
      input: commit("Update README"),
      expected: null,
    },
    {
      name: "keeps revert as a distinct type",
      input: commit("revert(agent): restore Code color"),
      expected: { type: "revert", scope: "agent", description: "restore Code color", breaking: false, sha },
    },
  ]

  for (const item of cases) {
    test(item.name, () => expect(toChange(item.input)).toEqual(item.expected))
  }
})

describe("classify", () => {
  const cases: Array<{ name: string; changes: Change[]; last: string; expected: "major" | "minor" | "patch" | null }> =
    [
      { name: "feature is minor", changes: [change("feat")], last: "0.2.0", expected: "minor" },
      { name: "fix is patch", changes: [change("fix")], last: "0.2.0", expected: "patch" },
      { name: "feature wins over fix", changes: [change("fix"), change("feat")], last: "0.2.0", expected: "minor" },
      {
        name: "non-release types do not bump",
        changes: [change("chore"), change("test"), change("docs")],
        last: "0.2.0",
        expected: null,
      },
      {
        name: "breaking changes are minor before 1.0",
        changes: [change("feat", { breaking: true })],
        last: "0.2.0",
        expected: "minor",
      },
      { name: "performance is patch", changes: [change("perf")], last: "0.2.0", expected: "patch" },
      { name: "revert is patch", changes: [change("revert")], last: "0.2.0", expected: "patch" },
      {
        name: "breaking changes are major after 1.0",
        changes: [change("feat", { breaking: true })],
        last: "1.4.0",
        expected: "major",
      },
    ]

  for (const item of cases) {
    test(item.name, () => expect(classify(item.changes, item.last)).toBe(item.expected))
  }
})

describe("version bumps", () => {
  test.each([
    ["major", "1.0.0"],
    ["minor", "0.3.0"],
    ["patch", "0.2.1"],
  ] as const)("bumps 0.2.0 by %s", (bump, expected) => {
    expect(bumpVersion("0.2.0", bump)).toBe(expected)
  })

  test("returns a release version without a prerelease", () => {
    expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.4")
  })

  test("derives auto from commits", () => {
    expect(nextVersion("0.2.0", [commit("feat: add feature")], "auto")).toBe("0.3.0")
  })

  test("fails auto when commits are not releasable", () => {
    expect(() => nextVersion("0.2.0", [commit("chore: tidy")], "auto")).toThrow(NoReleasableChangesError)
    expect(() => nextVersion("0.2.0", [commit("chore: tidy")], "auto")).toThrow("0.2.0..HEAD")
  })

  test("allows an explicit bump with only chores", () => {
    expect(nextVersion("0.2.0", [commit("chore: tidy")], "patch")).toBe("0.2.1")
  })
})

describe("devVersion", () => {
  test("increments the last tag and includes commit metadata", () => {
    expect(devVersion("0.2.0", 14, "1af5cf3", false)).toBe("0.2.1-dev.14+1af5cf3")
  })

  test("marks dirty worktrees", () => {
    expect(devVersion("0.2.0", 14, "1af5cf3", true)).toBe("0.2.1-dev.14+1af5cf3.dirty")
  })

  test("starts at 0.0.1 before the first tag", () => {
    expect(devVersion(null, 3, "abc1234", false)).toBe("0.0.1-dev.3+abc1234")
  })
})

describe("formatNotes", () => {
  test("orders sections, links PRs and commits, omits housekeeping, and adds the compare link", () => {
    const notes = formatNotes(
      [
        change("fix", { description: "repair issue", pr: 180 }),
        change("feat", { scope: "api", description: "change behavior", breaking: true, pr: 184 }),
        change("test", { description: "add tests" }),
        change("feat", { description: "add feature" }),
        change("revert", { description: "restore behavior" }),
        change("perf", { description: "speed up startup" }),
        change("chore", { description: "update tooling" }),
      ],
      { repo: "mdev34-lab/alphacode", prev: "v0.2.0", next: "v0.3.0" },
    )

    expect(notes.indexOf("### Breaking changes")).toBeLessThan(notes.indexOf("### Features"))
    expect(notes.indexOf("### Features")).toBeLessThan(notes.indexOf("### Fixes"))
    expect(notes.indexOf("### Fixes")).toBeLessThan(notes.indexOf("### Performance"))
    expect(notes).toContain("- **api:** change behavior ([#184](https://github.com/mdev34-lab/alphacode/pull/184))")
    expect(notes).toContain(
      "- add feature ([`1af5cf3`](https://github.com/mdev34-lab/alphacode/commit/1af5cf384aa3175aaca6e0fb7ce5279dc4bef8c3))",
    )
    expect(notes).toContain("- repair issue ([#180](https://github.com/mdev34-lab/alphacode/pull/180))")
    expect(notes).toContain(
      "- restore behavior ([`1af5cf3`](https://github.com/mdev34-lab/alphacode/commit/1af5cf384aa3175aaca6e0fb7ce5279dc4bef8c3))",
    )
    expect(notes).toContain("**Full diff:** https://github.com/mdev34-lab/alphacode/compare/v0.2.0...v0.3.0")
    expect(notes).not.toContain("add tests")
    expect(notes).not.toContain("update tooling")
  })

  test("omits the compare link without a previous tag", () => {
    const notes = formatNotes([change("feat", { description: "add feature" })], {
      repo: "mdev34-lab/alphacode",
      next: "v0.3.0",
    })
    expect(notes).not.toContain("Full diff:")
  })

  test("uses a placeholder when no user-facing changes are listed", () => {
    expect(
      formatNotes([change("docs", { description: "update docs" })], {
        repo: "mdev34-lab/alphacode",
        next: "v0.3.0",
      }),
    ).toBe("No user-facing changes recorded.")
  })
})

describe("parseVersion", () => {
  test("accepts a leading v and prerelease metadata", () => {
    expect(parseVersion("v1.2.3-rc.1+build.4")).toEqual({ major: 1, minor: 2, patch: 3, pre: "rc.1" })
  })

  test.each(["", "1.2", "v1.02.3", "1.2.3-01", "not-a-version", "1.2.3garbage"])(
    "rejects invalid version %s",
    (input) => expect(() => parseVersion(input)).toThrow(),
  )
})
