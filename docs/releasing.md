# Releasing AlphaCode

Releases are GitHub Releases built from tags. The release version is committed to the
repository before the release is cut: no release step rewrites history and nothing
commits back to `dev` on your behalf.

## The version source

Root `package.json` holds the one authoritative version. Everything else derives from it
and is checked against it:

| Surface | Example | Enforced by |
| --- | --- | --- |
| `package.json` (root) | `0.1.0` | `./script/bump.ts` is the only writer |
| `packages/opencode/package.json` (executable) | `0.1.0` | `./script/bump.ts`, `./script/release-check.ts` |
| Build / runtime (`alphacode --version`) | `0.1.0` | release guard in `@opencode-ai/script`, `--version` smoke test in `script/build.ts` |
| Git tag | `v0.1.0` | `./script/release-check.ts --tag v0.1.0` (runs in the publish workflow) |

A release build is always built from the exact tag, so a clean checkout of `vX.Y.Z`
reports `X.Y.Z` both from package metadata and from `alphacode --version`.

`0.1.0` is the inherited baseline. Local-only builds that were never committed, tagged
or released stay that way - no historical releases are manufactured for them.

## Cut a release

From a clean `dev` checkout, in this exact order:

```bash
# 1. Bump the authoritative version (deterministic SemVer; rewrites both package.json files)
./script/bump.ts patch                 # or minor / major / auto / X.Y.Z

# 2. Commit and push - the release tag is created at this commit
git add package.json packages/opencode/package.json
git commit -m "chore(release): v<version>"
git push origin dev

# 3. Preview the release notes (allowed from any ref; creates nothing)
./script/release --dry-run

# 4. Cut the release (dev only): pushes the tag, creates the draft release, builds
#    every target from that tag, attaches the archives, then publishes
./script/release
```

Step 4 is a `gh workflow run publish.yml --ref dev` dispatch. The workflow lifecycle is:

1. **version job** (`./script/version.ts`): validates the metadata, **pushes the tag to
   origin**, then creates the draft release bound to that tag. The tag comes first on
   purpose: a draft release creates no git ref until it is published, so without the
   explicit push the build job would have no tag to check out. The job is idempotent -
   a rerun adopts a tag it already pushed and a draft it already created, and rolls its
   own tag back if the draft creation fails.
2. **build job** (`./packages/opencode/script/build.ts`): checks out the pushed tag and
   builds from it, then uploads exactly the archives the build produced (a single-target
   build uploads its own archive; nothing is globbed).
3. **finalize job**: publishes the draft and marks it latest.

A tag that already points at a different commit, and a release that is already
published, are both hard errors - bump the version instead. The workflow never moves or
reuses someone else's tag.

### Choosing the bump

- `patch` / `minor` / `major`: explicit SemVer bump of the committed version.
- `auto`: derives the bump from conventional commits on the first-parent history since
  the last `vX.Y.Z` tag.
- `X.Y.Z`: explicit target version.

`auto` needs a previous tag, so the first AlphaCode release must be an explicit
`patch`, `minor`, `major`, or `X.Y.Z`. `./script/bump.ts` refuses to move the version
backwards, to bump to a prerelease, or to reuse a version that already has a tag.

| Commit | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:`, `perf:`, `revert:` | patch |
| `type!:` or a `BREAKING CHANGE:` footer | minor while the current major is 0; major once it is at least 1 |
| Other types | no bump |

`auto` fails when there are no releasable commits. It never moves version 0 to 1; use an
explicit version for that transition.

## Version checks

```bash
./script/release-check.ts                  # package metadata (and the tag at HEAD, when there is one)
./script/release-check.ts --tag v0.1.1     # strict: HEAD must really be tagged v0.1.1, on a clean tree
./script/bump.ts patch --dry-run           # print the bump, write nothing
```

The check exits non-zero and lists every disagreement (root vs executable package,
package vs tag, package vs runtime). It runs in both publish jobs, so a release whose
tag, package metadata and embedded version disagree cannot be built.

A clean checkout of a release tag is a release build on its own: `Script.channel` is
`latest` and the runtime reports the committed package version - but only when the tag
actually matches root `package.json`. A tag that disagrees with the package metadata
fails the build instead of silently lending it release semantics, and a checkout of a
tag with uncommitted changes reports `X.Y.Z+<sha>.dirty` (never the exact release
version), so a modified tree can never pass as the published artifact. Explicit
configuration (`ALPHACODE_CHANNEL`, `ALPHACODE_VERSION`, `ALPHACODE_BUMP`) keeps its own
semantics; the release guard still gates any actual publish.

`--tag` declares which release is being built; it never stands in for a missing one.
The strict form asks git directly (`git tag --points-at HEAD`) and refuses when HEAD is
untagged, when HEAD carries a different tag, or when tracked files have uncommitted
changes. `GITHUB_REF_NAME` and friends are never accepted as a substitute. The
metadata-only form is what the `version` job runs before any tag exists.

Unknown flags are errors, not fallbacks: `./script/bump.ts patch --dry-rnu` and
`./script/release-check.ts --tagg v0.1.1` both fail instead of quietly doing something
less strict - or, worse, a real write.

A development build can never publish a release: the build only uploads artifacts when
`ALPHACODE_RELEASE` is set, and `@opencode-ai/script` refuses to start a release build
whose version is not the exact, stable, committed package version, whose HEAD is not the
matching release tag, or whose tree is dirty. `./script/bump.ts` validates and rewrites
root `package.json` and `packages/opencode/package.json` together: both are read and
checked before either is written, so a half-bumped tree is impossible.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ALPHACODE_VERSION` | Version to build/embed; in a release build it must equal `package.json`. Implies the `latest` channel: combining it with an explicit non-`latest` channel is an error |
| `ALPHACODE_BUMP` | `auto`, `patch`, `minor` or `major`; forces the release channel |
| `ALPHACODE_CHANNEL` | `latest` for release builds; anything else is a development build |
| `ALPHACODE_RELEASE` | Truthy to attach build artifacts to the release |
| `ALPHACODE_RELEASE_ID` | Release database id; treated as a release signal |

The inherited `OPENCODE_VERSION`, `OPENCODE_BUMP`, `OPENCODE_CHANNEL` and
`OPENCODE_RELEASE_ID` names are still accepted as compatibility aliases (the nix
derivation uses them), but setting an alias and its `ALPHACODE_*` name to different
values is an error, not a silent choice. That includes release signals that contradict
each other: a new `ALPHACODE_RELEASE=false` beside an inherited `OPENCODE_RELEASE_ID`
fails the build instead of publishing on the strength of the inherited variable. Clear
one of them.

A release version is exactly `X.Y.Z`: no prerelease and no build metadata. `X.Y.Z+<sha>`
is a build artifact, never a release, and is rejected everywhere a release is expected.

## Reproduce a release

```bash
git checkout v<version>            # detached HEAD: the exact tagged commit, clean tree
./script/release-check.ts --tag v<version>
cd packages/opencode && bun run script/build.ts --single
./dist/alphacode-linux-x64/bin/alphacode --version   # prints <version>
```

The first two commands are the same ones the `build` job runs, so a release that cannot
be reproduced locally by this sequence cannot be published either.

## Builds and updates

Non-release builds are versioned `X.Y.(Z+1)-dev.N+<sha7>[.dirty]` (`0.0.1-dev.N+<sha7>`
before the first tag). Preview/local builds do not check for or install updates.

Release builds check this repository's latest GitHub Release. Patch updates install
automatically by default; major and minor updates notify instead. Set
`autoupdate: "notify"` in the user config to notify for patch updates too.

## Failures and hotfixes

A failed build leaves no published release: the `cleanup` job (`./script/release-cleanup.ts`)
deletes a leftover draft release together with its tag, or an orphan tag pushed before the
draft existed. A published release and its tag are never touched. Once cleanup has run, the
same version can be released again by re-running the workflow.

A hotfix is an ordinary release from `dev`: merge or cherry-pick the fix into `dev`,
then cut a normal patch release.
