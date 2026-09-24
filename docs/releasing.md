# Releasing AlphaCode

Releases are GitHub Releases built from tags. No package version file is edited and no bot commits back to `dev`.

## Cut a release

Use **Actions → publish → Run workflow** and select `dev`. Normally run `script/release` (auto bump), or choose an explicit `patch`, `minor`, or `major` bump. To preview first, run `script/release minor --dry-run`; dry runs are allowed from any ref and create no release. You can also set `VERSION=1.2.3` to override the version.

Auto bump examines conventional commits on the first-parent history since the last `vX.Y.Z` tag:

| Commit | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:`, `perf:`, `revert:` | patch |
| `type!:` or a `BREAKING CHANGE:` footer | minor while the current major is 0; major once it is at least 1 |
| Other types | no bump |

`auto` fails when there are no releasable commits. Auto bump never moves version 0 to 1; use an explicit `version=1.0.0` when making that transition.

## First tracked release

The first release establishes the tag baseline. On `dev`, run the workflow once with `version=0.2.0` and `dry_run=true`; verify the summary, then repeat with `dry_run=false`. Do not create a tag or edit a `package.json` by hand.

## Builds and updates

Non-release builds are versioned `X.Y.(Z+1)-dev.N+<sha7>[.dirty]` (`0.0.1-dev.N+<sha7>` before the first tag). Preview/local builds do not check for or install updates.

Release builds check this repository's latest GitHub Release. Patch updates install automatically by default; major and minor updates notify instead. Set `autoupdate: "notify"` in the user config to notify for patch updates too.

## Failures and hotfixes

A failed build leaves no published release: the `cleanup` job deletes a leftover draft. A hotfix is an ordinary release from `dev`: merge or cherry-pick the fix into `dev`, then cut a normal patch release.
