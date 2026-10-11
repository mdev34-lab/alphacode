import { parseVersion, type BumpInput } from "./version"

/**
 * AlphaCode release environment variables.
 *
 * `ALPHACODE_*` is the documented interface. The `OPENCODE_*` names survive as
 * compatibility aliases for inherited OpenCode tooling (nix derivations, older
 * workflow snippets), but they must never disagree with the AlphaCode name.
 */
export const ENV_NAMES = {
  version: ["ALPHACODE_VERSION", "OPENCODE_VERSION"],
  bump: ["ALPHACODE_BUMP", "OPENCODE_BUMP"],
  channel: ["ALPHACODE_CHANNEL", "OPENCODE_CHANNEL"],
  release: ["ALPHACODE_RELEASE", "ALPHACODE_RELEASE_ID", "OPENCODE_RELEASE", "OPENCODE_RELEASE_ID"],
} as const

export type Env = Record<string, string | undefined>

export class EnvConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnvConflictError"
  }
}

/**
 * Reads the first populated name, rejecting disagreeing aliases.
 */
export function envValue(env: Env, names: readonly string[]): string | undefined {
  const found = names
    .map((name) => ({ name, value: env[name]?.trim() }))
    .filter((entry): entry is { name: string; value: string } => entry.value !== undefined && entry.value !== "")

  if (found.length === 0) return undefined

  const distinct = [...new Set(found.map((entry) => entry.value))]
  if (distinct.length > 1) {
    throw new EnvConflictError(
      `Conflicting environment values: ${found.map((entry) => `${entry.name}=${entry.value}`).join(", ")}. Set exactly one of ${names.join(", ")}.`,
    )
  }

  return distinct[0]
}

export function resolveBump(raw: string | undefined): BumpInput | undefined {
  const input = raw?.trim().toLowerCase()
  if (!input) return undefined
  if (input === "auto" || input === "patch" || input === "minor" || input === "major") return input
  throw new Error(`Invalid bump: ${raw}. Expected auto, patch, minor, or major.`)
}

export function resolveVersion(raw: string | undefined): string | undefined {
  const input = raw?.trim()
  if (!input) return undefined
  // Throws when the override is not SemVer.
  parseVersion(input)
  return input.replace(/^v/, "")
}

const FALSEY = new Set(["0", "false", "no", "off"])

/**
 * Publishing is opt-in. A release flag that is explicitly disabled while a
 * legacy name still enables it is a conflict, not a silent decision: the build
 * must fail instead of publishing on the strength of an inherited variable.
 */
export function resolveRelease(env: Env): boolean {
  const found: { name: string; value: string }[] = []
  for (const name of ENV_NAMES.release) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== "") found.push({ name, value })
  }

  if (found.length === 0) return false

  const truthy = found.filter((entry) => !FALSEY.has(entry.value.toLowerCase()))
  const disabled = found.filter((entry) => FALSEY.has(entry.value.toLowerCase()))

  if (truthy.length > 0 && disabled.length > 0) {
    throw new EnvConflictError(
      `Conflicting release flags: ${found.map((entry) => `${entry.name}=${entry.value}`).join(", ")}. Clear one of them.`,
    )
  }

  return truthy.length > 0
}

/**
 * Fails when the release flags contradict each other (for example a new
 * `ALPHACODE_RELEASE=false` next to an inherited `OPENCODE_RELEASE_ID`). Call
 * before doing anything release-shaped so the conflict cannot be ignored.
 */
export function assertNoReleaseConflict(env: Env = process.env as Env): void {
  resolveRelease(env)
}

export interface ReleaseEnv {
  version?: string
  bump?: BumpInput
  channel?: string
  release: boolean
}

/**
 * Resolves every release input from the environment. Pure: safe to unit test
 * and free of git or filesystem access.
 */
export function resolveEnv(env: Env = process.env as Env): ReleaseEnv {
  const version = resolveVersion(envValue(env, ENV_NAMES.version))
  const bump = resolveBump(envValue(env, ENV_NAMES.bump))
  const channel = envValue(env, ENV_NAMES.channel)

  return {
    ...(version === undefined ? {} : { version }),
    ...(bump === undefined ? {} : { bump }),
    ...(channel === undefined ? {} : { channel }),
    release: resolveRelease(env),
  }
}
