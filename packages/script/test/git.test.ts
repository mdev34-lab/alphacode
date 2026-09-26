import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { commitCount, commitsSince, lastTag } from "../src/git"

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

describe("git release metadata", () => {
  test("selects stable version tags and reads only first-parent commits", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "alphacode-git-test-"))
    try {
      git(cwd, "init", "--quiet", "--initial-branch=main")
      git(cwd, "config", "user.name", "AlphaCode Test")
      git(cwd, "config", "user.email", "alphacode-test@example.com")

      await writeFile(path.join(cwd, "base.txt"), "base\n")
      git(cwd, "add", "--all")
      git(cwd, "commit", "--quiet", "-m", "feat: establish history")
      git(cwd, "tag", "v0.1.0")
      git(cwd, "tag", "vscode-v9.9.9")

      await writeFile(path.join(cwd, "release.txt"), "release\n")
      git(cwd, "add", "--all")
      git(cwd, "commit", "--quiet", "-m", "fix: prepare baseline")
      git(cwd, "tag", "v0.2.0")

      git(cwd, "checkout", "--quiet", "-b", "feature/inner")
      await writeFile(path.join(cwd, "feature.txt"), "feature\n")
      git(cwd, "add", "--all")
      git(cwd, "commit", "--quiet", "-m", "feat: inner branch commit")
      const innerCommit = git(cwd, "rev-parse", "HEAD")

      git(cwd, "checkout", "--quiet", "main")
      await writeFile(path.join(cwd, "main.txt"), "main\n")
      git(cwd, "add", "--all")
      git(cwd, "commit", "--quiet", "-m", "fix: first-parent commit")
      const firstParentCommit = git(cwd, "rev-parse", "HEAD")

      git(cwd, "merge", "--quiet", "--no-ff", "feature/inner", "-m", "Merge pull request #184 from test/inner")
      const mergeCommit = git(cwd, "rev-parse", "HEAD")

      expect(await lastTag(mergeCommit, cwd)).toBe("v0.2.0")
      const commits = await commitsSince("v0.2.0", mergeCommit, cwd)
      expect(commits.map((item) => item.sha)).toEqual([mergeCommit, firstParentCommit])
      expect(commits.map((item) => item.sha)).not.toContain(innerCommit)
      expect(await commitCount("v0.2.0", mergeCommit, cwd)).toBe(2)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
