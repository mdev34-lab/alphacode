#!/usr/bin/env bun

/**
 * Publish-failure cleanup.
 *
 *   ./script/release-cleanup.ts v0.1.1
 *
 * Removes the leftover state of a failed publish run: a draft release and its
 * tag, or an orphan tag pushed before the draft existed. A published release
 * (and its tag) is never touched - publishing is the point of no return.
 */

import { $ } from "bun"

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error("usage: ./script/release-cleanup.ts vX.Y.Z")
}
const repo = process.env.GH_REPO ?? "mdev34-lab/silvercode"

const view = await $`gh release view ${tag} --json isDraft --repo ${repo}`.nothrow().quiet()
if (view.exitCode === 0) {
  const { isDraft } = JSON.parse(view.stdout.toString())
  if (!isDraft) {
    console.log(`cleanup: ${tag} is published; leaving the release and its tag untouched`)
    process.exit(0)
  }
  // --cleanup-tag removes the remote tag together with the draft release.
  await $`gh release delete ${tag} --yes --cleanup-tag --repo ${repo}`
  console.log(`cleanup: deleted draft release ${tag} and its tag`)
  process.exit(0)
}

// No release object: the tag can still be an orphan from a version job that
// failed after pushing the tag but before the draft existed.
const ref = await $`gh api repos/${repo}/git/ref/tags/${tag}`.nothrow().quiet()
if (ref.exitCode === 0) {
  await $`gh api -X DELETE repos/${repo}/git/refs/tags/${tag}`
  console.log(`cleanup: deleted orphan tag ${tag}`)
} else {
  console.log(`cleanup: nothing to clean for ${tag}`)
}
