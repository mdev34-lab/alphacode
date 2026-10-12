import { $ } from "bun"
import semver from "semver"
import path from "path"
import { commitCount, commitsSince, isDirty, lastTag, shortSha, tagAtHead } from "./git"
import { devVersion, parseVersion, type Commit } from "./version"
import { resolveEnv } from "./env"
import { assertReleaseGate, assertReleaseVersions, tagForVersion } from "./release"

export { formatNotes, toChange } from "./version"
export {
  ENV_NAMES,
  assertNoReleaseConflict,
  resolveBump,
  resolveEnv,
  resolveRelease,
  resolveVersion,
  EnvConflictError,
} from "./env"
export {
  assertReleaseGate,
  assertReleaseVersions,
  BUMP_FLAGS,
  isReleaseVersion,
  parseBumpArgs,
  tagForVersion,
  validateReleaseGate,
  validateReleaseVersions,
  ReleaseValidationError,
} from "./release"
export { bumpPaths, preflightBump, rewriteVersion } from "./bump"
export { archiveName, archivePath, uploadReleaseArchives } from "./artifacts"
export type { ArchiveTarget } from "./artifacts"
export type { Env, ReleaseEnv } from "./env"
export type { BumpArgs, ReleaseFacts, ReleaseGate } from "./release"
export type { BumpPaths, BumpTargets } from "./bump"

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

// Root package.json is the single authoritative version source. Package metadata,
// the runtime version and the release tag must all agree with it.
const PACKAGE_VERSION = (() => {
  const value = rootPkg.version
  try {
    parseVersion(value)
  } catch {
    throw new Error(`Invalid version in root package.json: ${value}`)
  }
  return value as string
})()

const env = resolveEnv()
const BUMP = env.bump
const VERSION_OVERRIDE = env.version
const RELEASE = env.release

// The tag at the checked-out commit. Never derived from GITHUB_SHA: the publish
// workflow builds the tag while GITHUB_SHA still points at the dispatching ref.
let headTagPromise: Promise<string | null> | undefined
const getHeadTag = () => (headTagPromise ??= tagAtHead("HEAD"))

let dirtyPromise: Promise<boolean> | undefined
const getDirty = () => (dirtyPromise ??= isDirty())

const CHANNEL = await (async () => {
  if (env.channel) return env.channel
  if (BUMP) return "latest"
  // An explicit version is authoritative and avoids Git calls in shallow build jobs.
  if (VERSION_OVERRIDE) return "latest"
  // A checkout of a release tag is a release build even when it is detached.
  if (await getHeadTag()) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

// The tag that made this a release build on its own (no explicit channel, bump
// or version override). Only the implicit tag path is gated below: explicit
// configuration keeps its current semantics.
const IMPLICIT_TAG = !env.channel && !BUMP && !VERSION_OVERRIDE ? await getHeadTag() : null

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
  // Release builds report exactly the version committed in root package.json.
  if (!IS_PREVIEW) {
    if (IMPLICIT_TAG) {
      // The tag at HEAD is release metadata: it must agree with package.json
      // instead of silently lending a mismatched tree release semantics.
      assertReleaseVersions({ packageVersion: PACKAGE_VERSION, tag: IMPLICIT_TAG })
      // A dirty checkout of a tag is not the release. Mark the build like a
      // dirty development build instead of reporting the exact version, so the
      // modified tree can never pass as the published artifact.
      if (await getDirty()) return `${PACKAGE_VERSION}+${await shortSha()}.dirty`
    }
    return PACKAGE_VERSION
  }
  const [last, count, short, dirty] = await Promise.all([getPreviousTag(), getCommitCount(), shortSha(), isDirty()])
  return devVersion(last, count, short, dirty)
})()

// Publishing a release is only ever allowed for an exact, stable, committed version
// built from the matching tag on a clean tree.
if (RELEASE) {
  assertReleaseVersions({ packageVersion: PACKAGE_VERSION, runtimeVersion: VERSION })
  assertReleaseGate({
    expectedTag: tagForVersion(PACKAGE_VERSION),
    tagAtHead: await getHeadTag(),
    dirty: await getDirty(),
  })
}

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
  get packageVersion() {
    return PACKAGE_VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return RELEASE
  },
  get team() {
    return team
  },
  /** The tag git reports at HEAD, or null when HEAD is untagged. */
  get tagAtHead(): Promise<string | null> {
    return getHeadTag()
  },
  /** True when tracked files carry uncommitted changes. */
  get dirty(): Promise<boolean> {
    return getDirty()
  },
  get previousTag(): Promise<string | null> {
    return getPreviousTag()
  },
  get commits(): Promise<Commit[]> {
    return getCommits()
  },
}
console.log(
  `alphacode script`,
  JSON.stringify(
    { channel: CHANNEL, version: VERSION, packageVersion: PACKAGE_VERSION, preview: IS_PREVIEW, release: RELEASE, team },
    null,
    2,
  ),
)
