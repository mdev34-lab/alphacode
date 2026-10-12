import { parseVersion, TAG_RE } from "./version"

// A release version is exactly X.Y.Z: no prerelease, and no build metadata
// (`0.1.0+abc1234` is a build artifact, not a release).
const BUILD_METADATA_RE = /\+/

/**
 * True only for an exact SemVer release. Development builds (`X.Y.Z-dev.N+<sha>`)
 * and build-metadata versions (`X.Y.Z+<meta>`) are never release versions.
 */
export function isReleaseVersion(version: string): boolean {
  return !BUILD_METADATA_RE.test(version) && parseVersion(version).pre === undefined
}

export function tagForVersion(version: string): string {
  return `v${version}`
}

export class ReleaseValidationError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Release version validation failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
    this.name = "ReleaseValidationError"
    this.problems = problems
  }
}

export interface ReleaseFacts {
  /** Root `package.json` version: the single authoritative metadata source. */
  packageVersion: string
  /** `packages/opencode/package.json` version: the executable package metadata. */
  executableVersion?: string
  /** Version reported at runtime (`silvercode --version` / `Script.version`). */
  runtimeVersion?: string
  /** Git tag the release is built from, e.g. `v0.1.1`. */
  tag?: string
}

/**
 * Collects every package/runtime/tag disagreement. Returns an empty array when
 * all supplied facts describe one and the same release version.
 */
export function validateReleaseVersions(facts: ReleaseFacts): string[] {
  const problems: string[] = []
  const packageVersion = facts.packageVersion

  try {
    parseVersion(packageVersion)
  } catch {
    problems.push(`root package.json version ${JSON.stringify(packageVersion)} is not valid SemVer`)
    return problems
  }

  if (!isReleaseVersion(packageVersion)) {
    problems.push(
      `root package.json version ${packageVersion} is not an exact release version (no prerelease, no build metadata); run ./script/bump.ts`,
    )
  }

  if (facts.executableVersion !== undefined && facts.executableVersion !== packageVersion) {
    problems.push(
      `packages/opencode/package.json version ${facts.executableVersion} does not match root package.json version ${packageVersion}`,
    )
  }

  if (facts.tag !== undefined) {
    if (!TAG_RE.test(facts.tag)) {
      problems.push(`tag ${facts.tag} is not a release tag (expected vX.Y.Z)`)
    } else if (facts.tag !== tagForVersion(packageVersion)) {
      problems.push(
        `tag ${facts.tag} does not match root package.json version ${packageVersion} (expected ${tagForVersion(packageVersion)})`,
      )
    }
  }

  if (facts.runtimeVersion !== undefined && facts.runtimeVersion !== packageVersion) {
    problems.push(`runtime version ${facts.runtimeVersion} does not match root package.json version ${packageVersion}`)
  }

  return problems
}

export function assertReleaseVersions(facts: ReleaseFacts): void {
  const problems = validateReleaseVersions(facts)
  if (problems.length > 0) throw new ReleaseValidationError(problems)
}

export interface ReleaseGate {
  /** Tag the release must be built from, e.g. `v0.1.1`. */
  expectedTag: string
  /** Release tag git reports at HEAD, or null when HEAD is untagged. */
  tagAtHead: string | null
  /** True when tracked files carry uncommitted changes. */
  dirty: boolean
}

/**
 * A release is only ever built from an exact, git-verified tag on a clean
 * checkout. `--tag v0.1.1` on an untagged or dirty tree is not a release.
 */
export function validateReleaseGate(gate: ReleaseGate): string[] {
  const problems: string[] = []

  if (!gate.tagAtHead) {
    problems.push(`HEAD is not tagged ${gate.expectedTag}; a release must be built from an exact tag checkout`)
  } else if (gate.tagAtHead !== gate.expectedTag) {
    problems.push(`HEAD is tagged ${gate.tagAtHead} but the release version is ${gate.expectedTag}`)
  }

  if (gate.dirty) {
    problems.push("working tree has uncommitted changes to tracked files; a release must be built from a clean checkout")
  }

  return problems
}

export function assertReleaseGate(gate: ReleaseGate): void {
  const problems = validateReleaseGate(gate)
  if (problems.length > 0) throw new ReleaseValidationError(problems)
}

export const BUMP_FLAGS = ["--dry-run"] as const

export interface BumpArgs {
  bump: string
  dryRun: boolean
}

/** Classic Levenshtein distance: small inputs only, no early exit needed. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_unused, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}

/**
 * Parses `./script/bump.ts` arguments. Unknown flags are rejected instead of
 * being ignored, so a typo such as `--dry-rnu` can never silently turn into a
 * real write.
 */
export function parseBumpArgs(args: string[]): BumpArgs {
  let dryRun = false
  const positional: string[] = []

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg.startsWith("-")) {
      const bare = arg.replace(/^-+/, "").toLowerCase()
      // A hint only for what is plausibly a typo of the flag (one or two
      // edits away), never for an unrelated word that shares a substring.
      const hint = editDistance(bare, "dry-run") <= 2 ? " (did you mean --dry-run?)" : ""
      throw new Error(`Unknown flag "${arg}"${hint}. Supported flags: ${BUMP_FLAGS.join(", ")}`)
    }
    positional.push(arg)
  }

  if (positional.length > 1) {
    throw new Error(`Expected at most one bump argument, got ${positional.length}: ${positional.join(", ")}`)
  }

  return { bump: positional[0] ?? "patch", dryRun }
}
