#!/usr/bin/env bun

import { appendFile } from "node:fs/promises"
import { $ } from "bun"
import path from "path"
import {
  assertNoReleaseConflict,
  assertReleaseVersions,
  formatNotes,
  isReleaseVersion,
  preflightBump,
  Script,
  tagForVersion,
  toChange,
} from "@opencode-ai/script"

const root = path.resolve(import.meta.dir, "..")

// A disabled release flag next to an inherited release id is a contradiction,
// not a decision: fail before reading anything else.
assertNoReleaseConflict()

// Both manifests are read and validated before the first write, so the release
// can never be cut from metadata that disagrees with itself.
const targets = await preflightBump(root)

// Root package.json is the single authoritative version source: the release
// version is committed, never derived from the branch or from local history.
const version = targets.current
const tag = tagForVersion(version)

if (!isReleaseVersion(version)) {
  throw new Error(`Refusing to release ${version}: root package.json must hold a stable SemVer version.`)
}

assertReleaseVersions({ packageVersion: version, executableVersion: targets.executableVersion })

// Only the publish workflow creates a release; a local run is always a dry run.
if (process.env.DRY_RUN !== "1" && process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing to create a release outside the publish workflow. Use DRY_RUN=1 ./script/version.ts to preview.")
}

const repo = process.env.GH_REPO ?? "mdev34-lab/alphacode"
const sha = (await $`git rev-parse ${process.env.GITHUB_SHA ?? "HEAD"}`.text()).trim()

interface ReleaseState {
  tagName: string
  databaseId: number
  isDraft: boolean
}

/** The release object for the tag, or null when none exists. Draft lookups can lag, so callers retry. */
const viewRelease = async (): Promise<ReleaseState | null> => {
  const result = await $`gh release view ${tag} --json tagName,databaseId,isDraft --repo ${repo}`.nothrow().quiet()
  if (result.exitCode !== 0) return null
  return JSON.parse(result.stdout.toString())
}

// The remote is the source of truth for the tag. A draft release creates no
// git ref until it is published, so the publish workflow pushes the tag itself
// before the draft exists; local tag state can be stale and proves nothing.
const remoteTagLine = (await $`git ls-remote origin refs/tags/${tag}`.nothrow().text()).trim()
const remoteTagSha = remoteTagLine ? (remoteTagLine.split(/\s/)[0] ?? null) : null
if (remoteTagSha && remoteTagSha !== sha) {
  throw new Error(`Tag ${tag} already exists at ${remoteTagSha} but this release is ${sha}. Bump first: ./script/bump.ts patch`)
}

// A local tag that disagrees with the remote is a contradiction, never a hint.
const localTag = (await $`git rev-parse -q --verify refs/tags/${tag}^{commit}`.nothrow().text()).trim()
if (localTag && remoteTagSha && localTag !== remoteTagSha) {
  throw new Error(`Local tag ${tag} is ${localTag} but the remote tag is ${remoteTagSha}. Fetch tags and retry.`)
}

// A published release is final: the version can never be released again. An
// existing draft for the same commit is a retried run and is adopted below.
const existingRelease = await viewRelease()
if (existingRelease && !existingRelease.isDraft) {
  throw new Error(`Release ${tag} is already published. Bump first: ./script/bump.ts patch`)
}

const previousTag = await Script.previousTag
const notes = previousTag
  ? formatNotes(
      (await Script.commits).flatMap((commit) => {
        const change = toChange(commit)
        return change ? [change] : []
      }),
      { repo, prev: previousTag, next: tag },
    )
  : "Initial tracked release."
const notesFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/alphacode-release-notes.txt`
await Bun.write(notesFile, notes)

const writeOutput = async (values: string[]) => {
  if (!process.env.GITHUB_OUTPUT) return
  await appendFile(process.env.GITHUB_OUTPUT, `${values.join("\n")}\n`)
}

if (process.env.DRY_RUN === "1") {
  const summary = [
    "## Release dry run",
    "",
    `- Version: ${tag}`,
    `- Version source: root package.json`,
    `- Previous tag: ${previousTag ?? "none"}`,
    "",
    notes,
    "",
  ].join("\n")
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  } else {
    console.log(summary)
  }
  await writeOutput([`version=${version}`, `tag=${tag}`, `repo=${repo}`])
  process.exit(0)
}

// Lifecycle: push the tag to origin FIRST (a draft release creates no ref, and
// the build job checks the tag out), then create or adopt the draft release.
let pushedTag = false
if (!remoteTagSha) {
  // A local-only tag pointing at the release commit is leftover state; replace it.
  if (localTag) await $`git tag -d ${tag}`
  await $`git tag ${tag} ${sha}`
  await $`git push origin refs/tags/${tag}:refs/tags/${tag}`
  pushedTag = true
}

try {
  let release = existingRelease
  if (release) {
    console.log(`adopting existing draft release ${tag} (id ${release.databaseId})`)
  } else {
    await $`gh release create ${tag} -d --target ${sha} --title ${tag} --notes-file ${notesFile} --repo ${repo}`
    // Freshly created drafts can lag behind subsequent lookups; poll briefly.
    for (let attempt = 0; attempt < 10 && !release; attempt++) {
      if (attempt > 0) await Bun.sleep(1000)
      release = await viewRelease()
    }
    if (!release) throw new Error(`Draft release ${tag} was created but is not visible yet; rerun the workflow to adopt it`)
  }
  await writeOutput([
    `version=${version}`,
    `release_id=${release.databaseId}`,
    `tag=${release.tagName}`,
    `repo=${repo}`,
  ])
} catch (error) {
  // Roll back only what this run created, and only while it is still a draft:
  // a published release and a tag we did not push are never touched.
  if (pushedTag) {
    const leftover = await viewRelease()
    if (leftover?.isDraft) {
      const deleted = await $`gh release delete ${tag} --yes --repo ${repo}`.nothrow().quiet()
      if (deleted.exitCode !== 0) {
        console.error(
          `rollback: could not delete draft release ${tag}: ${deleted.stderr.toString().trim()}. Remove it with ./script/release-cleanup.ts ${tag}`,
        )
      }
    }
    const untagged = await $`git push origin --delete refs/tags/${tag}`.nothrow().quiet()
    if (untagged.exitCode !== 0) {
      console.error(
        `rollback: could not delete remote tag ${tag}: ${untagged.stderr.toString().trim()}. Remove it with ./script/release-cleanup.ts ${tag}`,
      )
    }
  }
  throw error
}
