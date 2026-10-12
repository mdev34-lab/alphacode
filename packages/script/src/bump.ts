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

// Escape-aware: the value capture swallows \" sequences whole, so an escaped
// quote can never truncate the value (the capture then fails SemVer validation,
// which is the fail-closed outcome).
const VERSION_FIELD = /"version"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"/g

interface JsonPosition {
  depth: number
  inString: boolean
}

/**
 * JSON depth and string state at `index`, counting braces outside strings.
 * Used to tell the top-level "version" field apart from a nested field with
 * the same name, and from text that merely looks like one inside a string.
 */
function jsonPositionAt(text: string, index: number): JsonPosition {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < index; i++) {
    const char = text[i]!
    if (escaped) {
      escaped = false
    } else if (char === "\\") {
      escaped = true
    } else if (char === '"') {
      inString = !inString
    } else if (!inString) {
      if (char === "{" || char === "[") depth++
      else if (char === "}" || char === "]") depth--
    }
  }
  return { depth, inString }
}

interface VersionField {
  value: string
  /** Start and end offsets of the quoted value, for surgical rewrites. */
  start: number
  end: number
}

/**
 * Locates the top-level "version" field. A nested object may carry its own
 * "version" key and a string may contain lookalike text, so only a field at
 * JSON depth 1 outside any string counts.
 */
function topLevelVersionField(text: string, label: string): VersionField {
  VERSION_FIELD.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VERSION_FIELD.exec(text))) {
    const position = jsonPositionAt(text, match.index)
    if (position.depth !== 1 || position.inString) continue
    const value = match[1]!
    const end = match.index + match[0].length - 1
    return { value, start: end - value.length, end }
  }
  throw new Error(`No top-level "version" field found in ${label}`)
}

export function bumpPaths(root: string): BumpPaths {
  return {
    root: `${root}/package.json`,
    executable: `${root}/packages/opencode/package.json`,
  }
}

function declaredVersion(text: string, label: string): string {
  return topLevelVersionField(text, label).value
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
  const field = topLevelVersionField(text, label)
  if (field.value !== from) throw new Error(`${label} declares ${field.value}, expected ${from}`)
  return `${text.slice(0, field.start)}${to}${text.slice(field.end)}`
}
