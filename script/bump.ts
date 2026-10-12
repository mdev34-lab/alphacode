#!/usr/bin/env bun

/**
 * Deterministic SemVer bump of the single authoritative version source.
 *
 *   ./script/bump.ts patch            # 0.1.0 -> 0.1.1
 *   ./script/bump.ts minor            # 0.1.0 -> 0.2.0
 *   ./script/bump.ts major            # 0.1.0 -> 1.0.0
 *   ./script/bump.ts auto             # derive the bump from conventional commits since the last vX.Y.Z tag
 *   ./script/bump.ts 0.2.0            # explicit version
 *   ./script/bump.ts patch --dry-run  # print only, write nothing
 *
 * Root `package.json` and the executable package (`packages/opencode/package.json`)
 * are validated together and written together, so package metadata can never
 * disagree with itself and a half-bumped tree is impossible.
 *
 * Flags are parsed strictly: an unknown flag (a typo such as `--dry-rnu`) is an
 * error, never a silent fall-through to a real write.
 */

import { $ } from "bun"
import path from "path"
import { commitsSince, lastTag } from "../packages/script/src/git"
import { bumpPaths, preflightBump, rewriteVersion } from "../packages/script/src/bump"
import { bumpVersion, nextVersion, parseVersion, type Bump } from "../packages/script/src/version"
import { isReleaseVersion, parseBumpArgs, tagForVersion } from "../packages/script/src/release"

const root = path.resolve(import.meta.dir, "..")
const paths = bumpPaths(root)
const label = (file: string) => path.relative(root, file)

// Rejects unknown flags and more than one bump argument before anything is read.
const { bump: input, dryRun } = parseBumpArgs(process.argv.slice(2))

const BUMP_TYPES: string[] = ["auto", "patch", "minor", "major"]

const compare = (left: string, right: string): number => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  return 0
}

// Reads and validates BOTH manifests before either one is written.
const targets = await preflightBump(root)
const current = targets.current

const next = await (async (): Promise<string> => {
  if (!BUMP_TYPES.includes(input)) {
    const candidate = input.replace(/^v/, "")
    parseVersion(candidate)
    if (!isReleaseVersion(candidate)) throw new Error(`Refusing to bump to a non-release version: ${candidate}`)
    return candidate
  }

  if (input === "auto") {
    const last = await lastTag("HEAD")
    if (!last) {
      throw new Error(
        "No v* tag found; pass an explicit bump (patch, minor, major) or version instead of auto for the first release.",
      )
    }
    return nextVersion(last, await commitsSince(last, "HEAD"), "auto")
  }

  return bumpVersion(current, input as Bump)
})()

if (!isReleaseVersion(next)) throw new Error(`Refusing to bump to a non-release version: ${next}`)
if (compare(next, current) <= 0) {
  throw new Error(`Refusing to move the version backwards: ${current} -> ${next}. Pass a higher version.`)
}

const tag = tagForVersion(next)
const existing = await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow().text()
if (existing.trim()) {
  throw new Error(`Tag ${tag} already exists at ${existing.trim()}. Choose a higher version.`)
}

// Both files are rewritten from the preflighted text, so a failure in the
// second rewrite leaves the first one untouched on disk.
const updated = {
  root: rewriteVersion(targets.rootText, current, next, label(paths.root)),
  executable: rewriteVersion(targets.executableText, current, next, label(paths.executable)),
}

if (!dryRun) {
  await Bun.file(paths.root).write(updated.root)
  await Bun.file(paths.executable).write(updated.executable)

  for (const file of [paths.root, paths.executable]) {
    const written = (await Bun.file(file).json()).version
    if (written !== next) throw new Error(`${label(file)} reports ${written} after the bump, expected ${next}`)
  }
}

console.log(`${dryRun ? "dry-run" : "bump"}: ${current} -> ${next} (${input})`)
if (dryRun) process.exit(0)

console.log(`updated ${label(paths.root)}`)
console.log(`updated ${label(paths.executable)}`)
console.log(`next: git commit -am "chore(release): ${tag}" && git push origin dev, then run ./script/release`)
