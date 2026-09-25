import { $ } from "bun"
import { TAG_RE, type Commit } from "./version"

export async function lastTag(sha: string, cwd = process.cwd()): Promise<string | null> {
  const tags = await $`git tag --list 'v[0-9]*' --merged ${sha} --sort=-v:refname`.cwd(cwd).text()
  return tags
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .find((tag) => TAG_RE.test(tag)) ?? null
}

export async function commitsSince(tag: string | null, sha: string, cwd = process.cwd()): Promise<Commit[]> {
  const output = tag
    ? await $`git log --first-parent --format=%H%x1f%s%x1f%b%x1e ${tag}..${sha}`.cwd(cwd).text()
    : await $`git log --first-parent --format=%H%x1f%s%x1f%b%x1e ${sha}`.cwd(cwd).text()

  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", ...body] = record.split("\x1f")
      return { sha, subject, body: body.join("\x1f").trim() }
    })
}

export async function commitCount(tag: string | null, sha: string, cwd = process.cwd()): Promise<number> {
  const output = tag
    ? await $`git rev-list --first-parent --count ${tag}..${sha}`.cwd(cwd).text()
    : await $`git rev-list --first-parent --count ${sha}`.cwd(cwd).text()
  return Number(output.trim())
}

export async function shortSha(cwd = process.cwd()): Promise<string> {
  return (await $`git rev-parse HEAD`.cwd(cwd).text()).trim().slice(0, 7)
}

export async function isDirty(cwd = process.cwd()): Promise<boolean> {
  return (await $`git status --porcelain`.cwd(cwd).text()).trim().length > 0
}
