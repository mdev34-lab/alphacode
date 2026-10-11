import { parseVersion } from "./version"
import { isReleaseVersion } from "./release"

/**
 * Bump preflight: reads both version-bearing package manifests and proves they
 * can be rewritten before anything is written. Used by `./script/bump.ts` so a
 * half-bumped tree is impossible.
 */

export interface BumpPaths {
  /** Root `package.json`: the authoritative version. */
  root: string
  /** `packages/opencode/package.json`: the executable package version. */
  executable: string
}

export interface BumpTargets {
  /** Version the root manifest declares: the authoritative version. */
  current: string
  /** Version the executable package manifest declares. */
  executableVersion: string
  rootText: string
  executableText: string
}

const VERSION_FIELD = /^([ \t]*"version"[ \t]*:[ \t]*")([^"]*)(")/m

export function bumpPaths(root: string): BumpPaths {
  return {
    root: `${root}/package.json`,
    executable: `${root}/packages/opencode/package.json`,
  }
}

function declaredVersion(text: string, label: string): string {
  const match = VERSION_FIELD.exec(text)
  if (!match) throw new Error(`No "version" field found in ${label}`)
  return match[2]
}

/**
 * Reads and validates both manifests. Throws before any write when the two
 * versions disagree, when either is not a stable SemVer release, or when the
 * field that would be rewritten is missing.
 */
export async function preflightBump(root: string): Promise<BumpTargets> {
  const paths = bumpPaths(root)
  const [rootText, executableText] = await Promise.all([
    Bun.file(paths.root).text(),
    Bun.file(paths.executable).text(),
  ])

  const rootVersion = declaredVersion(rootText, paths.root)
  const executableVersion = declaredVersion(executableText, paths.executable)

  try {
    parseVersion(rootVersion)
  } catch {
    throw new Error(`Root package.json version ${rootVersion} is not valid SemVer`)
  }

  if (!isReleaseVersion(rootVersion)) {
    throw new Error(
      `Root package.json version ${rootVersion} is not an exact release version; bumping requires a clean SemVer release`,
    )
  }

  if (executableVersion !== rootVersion) {
    throw new Error(
      `packages/opencode/package.json version ${executableVersion} does not match root package.json version ${rootVersion}; fix the metadata before bumping`,
    )
  }

  return { current: rootVersion, executableVersion, rootText, executableText }
}

/**
 * Rewrites only the `"version"` field, leaving the rest of the file byte-identical.
 */
export function rewriteVersion(text: string, from: string, to: string, label: string): string {
  const match = VERSION_FIELD.exec(text)
  if (!match) throw new Error(`No "version" field found in ${label}`)
  if (match[2] !== from) throw new Error(`${label} declares ${match[2]}, expected ${from}`)
  return text.replace(VERSION_FIELD, (_full, prefix: string, _value: string, suffix: string) => `${prefix}${to}${suffix}`)
}
