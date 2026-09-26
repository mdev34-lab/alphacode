#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

const writeOutput = async (values: string[]) => {
  if (!process.env.GITHUB_OUTPUT) return
  const { appendFile } = await import("node:fs/promises")
  await appendFile(process.env.GITHUB_OUTPUT, `${values.join("\n")}\n`)
}

if (process.env.DRY_RUN === "1") {
  if (!Script.preview) {
    try {
      await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
    } catch {
      // Changelog generation is best-effort; fall back to a static note if the
      // CLI is not yet available (e.g. first publish before the package exists
      // on npm).
    }
  }
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/silvercode-release-notes.txt`
  await Bun.write(notesFile, body)

  const summary = [
    "## Release dry run",
    "",
    `- Version: v${Script.version}`,
    `- Bump: ${process.env.OPENCODE_BUMP ?? "auto"}${process.env.OPENCODE_VERSION ? " (version override takes precedence)" : ""}`,
    "",
    body,
    "",
  ].join("\n")
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises")
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  } else {
    console.log(summary)
  }
  await writeOutput([`version=${Script.version}`, `repo=${process.env.GH_REPO}`])
  process.exit(0)
}

if (!Script.preview) {
  try {
    await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
  } catch {
    // Changelog generation is best-effort; fall back to a static note if the
    // CLI is not yet available (e.g. first publish before the package exists
    // on npm).
  }
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/silvercode-release-notes.txt`
  await Bun.write(notesFile, body)
  await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --notes-file ${notesFile}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --repo ${process.env.GH_REPO}`
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

await writeOutput(output)

process.exit(0)