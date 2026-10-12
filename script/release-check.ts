#!/usr/bin/env bun

/**
 * Release version check.
 *
 *   ./script/release-check.ts                 # package metadata (+ the tag at HEAD, when there is one)
 *   ./script/release-check.ts --tag v0.1.1    # strict: HEAD must be tagged v0.1.1 on a clean tree
 *
 * `--tag` declares which release is being built; it never stands in for a
 * missing one. With `--tag` the check demands that the tag really points at
 * HEAD and that the tree is clean, so an untagged or dirty tree can never pass
 * as a release.
 *
 * Exits non-zero and lists every disagreement. Reads and writes nothing.
 * The runtime half of the chain is enforced by the release guard in
 * `@opencode-ai/script` and by the `--version` smoke test in the build.
 */

import path from "path"
import { isDirty, tagAtHead } from "../packages/script/src/git"
import {
  assertReleaseGate,
  assertReleaseVersions,
  ReleaseValidationError,
  tagForVersion,
} from "../packages/script/src/release"

const root = path.resolve(import.meta.dir, "..")

const args = process.argv.slice(2)

// Unknown flags are rejected instead of ignored: a typo must never turn a
// strict check into a lenient one.
const RELEASE_CHECK_FLAGS = ["--tag"] as const
let expectedTag: string | undefined
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}". Usage: ./script/release-check.ts [--tag vX.Y.Z]`)
  const [name, inlineValue] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined]
  if (name !== RELEASE_CHECK_FLAGS[0]) {
    const hint = name?.includes("tag") ? " (did you mean --tag vX.Y.Z?)" : ""
    throw new Error(`Unknown flag "${name}"${hint}. Supported flags: ${RELEASE_CHECK_FLAGS.join(", ")}`)
  }
  const value = inlineValue ?? args[++index]
  if (!value) throw new Error(`--tag needs a value, e.g. --tag ${tagForVersion("0.1.1")}`)
  expectedTag = value
}

const rootPkg = await Bun.file(path.join(root, "package.json")).json()
const executablePkg = await Bun.file(path.join(root, "packages", "opencode", "package.json")).json()
const packageVersion = rootPkg.version

try {
  assertReleaseVersions({
    packageVersion,
    executableVersion: executablePkg.version,
    ...(expectedTag ? { tag: expectedTag } : {}),
  })

  // The tag git reports at HEAD is the only tag evidence accepted here:
  // GITHUB_REF_NAME and friends are never substituted for a missing tag.
  const headTag = await tagAtHead("HEAD", root)

  if (expectedTag) {
    assertReleaseGate({ expectedTag, tagAtHead: headTag, dirty: await isDirty(root) })
  } else if (headTag) {
    assertReleaseVersions({ packageVersion, tag: headTag })
  }

  const suffix = expectedTag ? ` (tag ${expectedTag})` : headTag ? ` (tag ${headTag})` : " (no tag at HEAD)"
  console.log(`release-check ok: ${packageVersion}${suffix}`)
} catch (error) {
  if (error instanceof ReleaseValidationError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
