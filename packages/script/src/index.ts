import { $ } from "bun"
import semver from "semver"
import path from "path"
import { commitCount, commitsSince, isDirty, lastTag, shortSha } from "./git"
import { devVersion, nextVersion, parseVersion, type BumpInput, type Commit } from "./version"

export { formatNotes, toChange } from "./version"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE_ID: process.env["OPENCODE_RELEASE_ID"],
}
const bumpInput = env.OPENCODE_BUMP?.trim().toLowerCase()
const BUMP: BumpInput | undefined = (() => {
  if (!bumpInput) return undefined
  if (bumpInput === "auto" || bumpInput === "patch" || bumpInput === "minor" || bumpInput === "major") return bumpInput
  throw new Error(`Invalid OPENCODE_BUMP: ${env.OPENCODE_BUMP}. Expected auto, patch, minor, or major.`)
})()

const VERSION_OVERRIDE = (() => {
  const input = env.OPENCODE_VERSION
  if (!input) return undefined
  try {
    parseVersion(input)
  } catch {
    throw new Error(`Invalid OPENCODE_VERSION: ${input}`)
  }
  return input.replace(/^v/, "")
})()

const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (BUMP) return "latest"
  // An explicit version is authoritative and avoids Git calls in shallow build jobs.
  if (VERSION_OVERRIDE) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"
const sha = process.env.GITHUB_SHA ?? "HEAD"

let previousTagPromise: Promise<string | null> | undefined
const getPreviousTag = () => (previousTagPromise ??= lastTag(sha))

let commitCountPromise: Promise<number> | undefined
const getCommitCount = () =>
  (commitCountPromise ??= (async () => commitCount(await getPreviousTag(), sha))())

let commitsPromise: Promise<Commit[]> | undefined
const getCommits = () => (commitsPromise ??= (async () => commitsSince(await getPreviousTag(), sha))())

const VERSION = await (async () => {
  if (VERSION_OVERRIDE) return VERSION_OVERRIDE
  if (IS_PREVIEW) {
    const [last, count, short, dirty] = await Promise.all([getPreviousTag(), getCommitCount(), shortSha(), isDirty()])
    return devVersion(last, count, short, dirty)
  }

  const last = await getPreviousTag()
  if (!last) throw new Error("No v* tag found. Cut the baseline once with OPENCODE_VERSION=0.2.0")
  if ((await getCommitCount()) === 0) throw new Error(`Nothing new since ${last}`)
  return nextVersion(last, await getCommits(), BUMP ?? "auto")
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE_ID
  },
  get team() {
    return team
  },
  get previousTag(): Promise<string | null> {
    return getPreviousTag()
  },
  get commits(): Promise<Commit[]> {
    return getCommits()
  },
}
console.log(
  `opencode script`,
  JSON.stringify({ channel: CHANNEL, version: VERSION, preview: IS_PREVIEW, release: Script.release, team }, null, 2),
)
