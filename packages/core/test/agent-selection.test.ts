import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { AgentSelection } from "@opencode-ai/core/agent-selection"
import { tmpdir } from "./fixture/tmpdir"

describe("AgentSelection", () => {
  describe("isLaunchAgent", () => {
    test("recognizes work and code case-insensitively", () => {
      expect(AgentSelection.isLaunchAgent("work")).toBe(true)
      expect(AgentSelection.isLaunchAgent("code")).toBe(true)
      expect(AgentSelection.isLaunchAgent("Work")).toBe(true)
      expect(AgentSelection.isLaunchAgent("CODE")).toBe(true)
    })

    test("rejects non-agent values", () => {
      expect(AgentSelection.isLaunchAgent("plan")).toBe(false)
      expect(AgentSelection.isLaunchAgent("./code")).toBe(false)
      expect(AgentSelection.isLaunchAgent("codex")).toBe(false)
      expect(AgentSelection.isLaunchAgent("")).toBe(false)
    })
  })

  describe("resolvePositional", () => {
    test("treats a missing agent name as an agent override", () => {
      expect(AgentSelection.resolvePositional("code", () => false)).toEqual({ agent: "code" })
      expect(AgentSelection.resolvePositional("WORK", () => false)).toEqual({ agent: "work" })
    })

    test("treats an existing path even when it looks like an agent name", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "code"))
      const exists = (p: string) => existsSync(p) || existsSync(path.join(tmp.path, p))
      expect(AgentSelection.resolvePositional("code", exists)).toEqual({ path: "code" })
    })

    test("treats relative and absolute paths as paths", () => {
      expect(AgentSelection.resolvePositional("./code", () => false)).toEqual({ path: "./code" })
      expect(AgentSelection.resolvePositional("/tmp/code", () => false)).toEqual({ path: "/tmp/code" })
    })

    test("returns an empty result for missing or empty values", () => {
      expect(AgentSelection.resolvePositional(undefined, () => false)).toEqual({})
      expect(AgentSelection.resolvePositional("", () => false)).toEqual({})
    })
  })

  describe("findGitRoot", () => {
    test("returns undefined outside a Git worktree", async () => {
      await using tmp = await tmpdir()
      expect(AgentSelection.findGitRoot(tmp.path)).toBeUndefined()
    })

    test("finds the root from a nested directory", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, ".git"))
      const nested = path.join(tmp.path, "packages", "opencode", "src")
      await fs.mkdir(nested, { recursive: true })
      expect(AgentSelection.findGitRoot(nested)).toBe(tmp.path)
    })

    test("treats a .git file (linked worktree) as a root", async () => {
      await using tmp = await tmpdir()
      await fs.writeFile(path.join(tmp.path, ".git"), `gitdir: ${path.join(tmp.path, "main", ".git", "worktrees", "side")}\n`)
      expect(AgentSelection.findGitRoot(path.join(tmp.path, "src"))).toBe(tmp.path)
    })
  })

  describe("inferAgent", () => {
    test("selects code for Git workspaces", () => {
      expect(AgentSelection.inferAgent({ gitRoot: "/repo" })).toBe("code")
    })

    test("selects work outside Git workspaces", () => {
      expect(AgentSelection.inferAgent({ gitRoot: undefined })).toBe("work")
    })

    test("defers to a configured default agent", () => {
      expect(AgentSelection.inferAgent({ gitRoot: "/repo", configuredDefault: "planner" })).toBeUndefined()
    })
  })
})
