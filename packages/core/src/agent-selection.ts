export * as AgentSelection from "./agent-selection"

import { existsSync } from "fs"
import path from "path"

/** Canonical id of the general-purpose workhorse agent. */
export const WORK = "work"
/** Canonical id of the software-engineering agent. */
export const CODE = "code"

export type LaunchAgent = typeof WORK | typeof CODE

/** Message shown when Code is launched outside a Git repository. */
export const CODE_REFUSAL = "Code requires a Git repository. Use Work for general filesystem tasks."

/** True when a CLI positional names a launch agent (case-insensitive). */
export function isLaunchAgent(value: string): value is LaunchAgent {
  const name = value.toLowerCase()
  return name === WORK || name === CODE
}

/**
 * Resolves a CLI positional into either an agent override or a project path.
 * A value that names a launch agent and does not exist on disk is treated as
 * an agent selection, so `alphacode ./code` still opens a folder named code.
 */
export function resolvePositional(value: string | undefined, exists: (target: string) => boolean): {
  agent?: LaunchAgent
  path?: string
} {
  if (value === undefined || value === "") return {}
  const name = value.toLowerCase()
  if (name === WORK && !exists(value)) return { agent: WORK }
  if (name === CODE && !exists(value)) return { agent: CODE }
  return { path: value }
}

/**
 * Finds the nearest ancestor of `directory` (inclusive) that contains a
 * `.git` entry. A `.git` file counts as well as a directory, so linked
 * worktrees are found too. This is a launch heuristic: it does not verify
 * the entry belongs to a healthy repository.
 */
export function findGitRoot(directory: string): string | undefined {
  let current = path.resolve(directory)
  // Path depth is bounded by the filesystem; the loop limit only guards
  // against symlink cycles or a corrupted directory chain.
  for (let depth = 0; depth < 128; depth++) {
    if (existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Infers the launch agent from the working directory. An explicitly
 * configured default agent always wins, so inference only fills the gap
 * where no agent was requested or configured. Git workspaces get Code,
 * everything else gets Work.
 */
export function inferAgent(input: { gitRoot?: string; configuredDefault?: string }): LaunchAgent | undefined {
  if (input.configuredDefault) return undefined
  return input.gitRoot ? CODE : WORK
}
