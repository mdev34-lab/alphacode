#!/usr/bin/env bun

import { appendFile } from "node:fs/promises"
import { $ } from "bun"
import { Script } from "@opencode-ai/script"
import { formatNotes, toChange } from "../packages/script/src/version"

if (Script.preview) throw new Error("publish workflow only supports release builds")

const repo = process.env.GH_REPO ?? "mdev34-lab/alphacode"
const sha = process.env.GITHUB_SHA ?? "HEAD"
const bump = process.env.OPENCODE_BUMP?.trim().toLowerCase() || "auto"
const previousTag = await Script.previousTag
const notes = previousTag
  ? formatNotes(
      (await Script.commits).flatMap((commit) => {
        const change = toChange(commit)
        return change ? [change] : []
      }),
      { repo, prev: previousTag, next: `v${Script.version}` },
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
    `- Version: v${Script.version}`,
    `- Previous tag: ${previousTag ?? "none"}`,
    `- Bump: ${bump}${process.env.OPENCODE_VERSION ? " (version override takes precedence)" : ""}`,
    "",
    notes,
    "",
  ].join("\n")
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  } else {
    console.log(summary)
  }
  await writeOutput([`version=${Script.version}`, `repo=${repo}`])
  process.exit(0)
}

await $`gh release create v${Script.version} -d --target ${sha} --title v${Script.version} --notes-file ${notesFile} --repo ${repo}`
const release = await $`gh release view v${Script.version} --json tagName,databaseId --repo ${repo}`.json()
await writeOutput([
  `version=${Script.version}`,
  `release=${release.databaseId}`,
  `tag=${release.tagName}`,
  `repo=${repo}`,
])
