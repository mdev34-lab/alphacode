import { $ } from "bun"

/**
 * Release archive naming and upload.
 *
 * The release build produces one archive per target in `dist/`: Linux targets
 * are `.tar.gz`, every other target is `.zip`. The upload step must enumerate
 * the archives the build actually produced: globbing both extensions fails on
 * a single-target build, because one of the two globs matches nothing.
 */

export interface ArchiveTarget {
  /** Target directory name under `dist/`, e.g. `silvercode-ai-linux-x64`. */
  name: string
  /** Target operating system as built (`linux`, `darwin`, `win32`). */
  os: string
}

/** Archive file name for one built target. */
export function archiveName(target: ArchiveTarget): string {
  return target.os === "linux" ? `${target.name}.tar.gz` : `${target.name}.zip`
}

/** Archive path relative to the package directory, as passed to `gh release upload`. */
export function archivePath(target: ArchiveTarget): string {
  return `./dist/${archiveName(target)}`
}

/**
 * Uploads exactly the given archives to the release. Every archive must exist
 * on disk first: a missing archive is a build failure, never a silent skip.
 */
export async function uploadReleaseArchives(
  tag: string,
  archives: string[],
  repo: string | undefined = process.env.GH_REPO,
): Promise<void> {
  if (archives.length === 0) throw new Error("No release archives to upload")
  for (const archive of archives) {
    if (!(await Bun.file(archive).exists())) {
      throw new Error(`Release archive missing on disk: ${archive}`)
    }
  }
  if (repo) {
    await $`gh release upload ${tag} ${archives} --clobber --repo ${repo}`
  } else {
    await $`gh release upload ${tag} ${archives} --clobber`
  }
}
