export type Bump = "major" | "minor" | "patch"
export type BumpInput = Bump | "auto"

export interface Commit {
  sha: string
  subject: string
  body: string
}

export interface Change {
  type: string
  scope?: string
  description: string
  breaking: boolean
  pr?: number
  sha: string
}

export const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/

export class NoReleasableChangesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoReleasableChangesError"
  }
}

export function parseVersion(v: string): { major: number; minor: number; patch: number; pre?: string } {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
    v,
  )
  if (!match) throw new Error(`Invalid version: ${v}`)

  const pre = match[4]
  if (pre?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`Invalid version: ${v}`)
  }

  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid version: ${v}`)

  return {
    major,
    minor,
    patch,
    ...(pre ? { pre } : {}),
  }
}

export function toChange(c: Commit): Change | null {
  const merge = /^Merge pull request #(\d+) /.exec(c.subject)
  const header = merge
    ? c.body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : c.subject
  if (!header) return null

  const match = /^(?<type>[a-z]+)(\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<rest>.+)$/.exec(header)
  if (!match?.groups) return null

  const rest = match.groups.rest
  const prs = Array.from(rest.matchAll(/\(#(\d+)\)/g), (item) => Number(item[1]))
  const description = rest.replace(/\s*\(#\d+\)/g, "").replace(/\s+/g, " ").trim()
  const pr = prs.at(-1) ?? (merge ? Number(merge[1]) : undefined)

  return {
    type: match.groups.type.toLowerCase(),
    ...(match.groups.scope ? { scope: match.groups.scope } : {}),
    description,
    breaking: !!match.groups.bang || /^BREAKING[ -]CHANGE:/m.test(c.body),
    ...(pr !== undefined ? { pr } : {}),
    sha: c.sha,
  }
}

export function classify(changes: Change[], last: string): Bump | null {
  const major = parseVersion(last).major
  let result: Bump | null = null
  const rank: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }

  for (const change of changes) {
    const bump = change.breaking
      ? major === 0
        ? "minor"
        : "major"
      : change.type === "feat"
        ? "minor"
        : ["fix", "perf", "revert"].includes(change.type)
          ? "patch"
          : null
    if (bump && (!result || rank[bump] > rank[result])) result = bump
  }

  return result
}

export function bumpVersion(last: string, bump: Bump): string {
  const version = parseVersion(last)
  if (bump === "major") return `${version.major + 1}.0.0`
  if (bump === "minor") return `${version.major}.${version.minor + 1}.0`
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

export function nextVersion(last: string, commits: Commit[], input: BumpInput): string {
  if (input !== "auto") return bumpVersion(last, input)

  const bump = classify(
    commits.map(toChange).filter((change): change is Change => change !== null),
    last,
  )
  if (!bump) {
    throw new NoReleasableChangesError(
      `No releasable changes in ${last}..HEAD; pass an explicit bump (patch, minor, or major).`,
    )
  }
  return bumpVersion(last, bump)
}

export function devVersion(last: string | null, count: number, sha: string, dirty: boolean): string {
  const base = last ? bumpVersion(last, "patch") : "0.0.1"
  return `${base}-dev.${count}+${sha}${dirty ? ".dirty" : ""}`
}

export function formatNotes(changes: Change[], o: { repo: string; prev?: string; next: string }): string {
  const omitted = new Set(["test", "chore", "docs", "style", "ci", "build", "refactor"])
  const visible = changes.filter((change) => change.breaking || !omitted.has(change.type))
  const line = (change: Change) => {
    const description = change.scope ? `**${change.scope}:** ${change.description}` : change.description
    const link = change.pr
      ? `[#${change.pr}](https://github.com/${o.repo}/pull/${change.pr})`
      : `[\`${change.sha.slice(0, 7)}\`](https://github.com/${o.repo}/commit/${change.sha})`
    return `- ${description} (${link})`
  }
  const section = (title: string, items: Change[]) => (items.length ? `### ${title}\n${items.map(line).join("\n")}` : "")
  const sections = [
    section("Breaking changes", visible.filter((change) => change.breaking)),
    section("Features", visible.filter((change) => change.type === "feat" && !change.breaking)),
    section("Fixes", visible.filter((change) => ["fix", "revert"].includes(change.type) && !change.breaking)),
    section("Performance", visible.filter((change) => change.type === "perf" && !change.breaking)),
  ].filter(Boolean)
  const body = sections.length ? sections.join("\n\n") : "No user-facing changes recorded."
  if (!o.prev) return body
  return `${body}\n\n**Full diff:** https://github.com/${o.repo}/compare/${o.prev}...${o.next}`
}
