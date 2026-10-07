import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The release surface spans several files that never import each other: the
// installer shell script, the npm package metadata, the postinstall shim, the
// publish scripts, and the publish workflow. A rename has to keep the artifact
// base name, the release repository, and the workflow guard in agreement, or
// the installer 404s and no release can ever be cut. These tests read the files
// as text so a mismatch fails CI instead of shipping.

const root = join(import.meta.dir, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const REPO = "mdev34-lab/alphacode"

describe("release surface", () => {
  test("installer requests the artifact names that the build publishes", () => {
    const install = read("install")
    const app = install.match(/^APP=(.+)$/m)?.[1]
    expect(app).toBeDefined()

    const pkg = JSON.parse(read("packages/opencode/package.json")) as { name: string; bin: Record<string, string> }
    // `packages/opencode/script/build.ts` names every dist folder and archive
    // after pkg.name, so the installer must request that exact prefix.
    expect(app).toBe(pkg.name)

    // Postinstall derives the same base when it fetches the platform package.
    expect(read("packages/opencode/script/postinstall.mjs")).toContain(`const base = \`${pkg.name}-\${platform}-\${arch}\``)

    // The published binary keeps the product name.
    expect(Object.keys(pkg.bin)).toEqual(["silvercode"])
  })

  test("installer and updater point at the repository that actually exists", () => {
    const install = read("install")
    expect(install).toContain(`https://github.com/${REPO}/releases/latest/download/install`)
    expect(install).not.toContain("/silvercode/releases")

    const installation = read("packages/opencode/src/installation/index.ts")
    expect(installation).toContain(`const REPO = "${REPO}"`)
  })

  test("publish workflow is gated on the repository owner, not a renamed repo", () => {
    const workflow = read(".github/workflows/publish.yml")
    expect(workflow).toContain("github.repository_owner == 'mdev34-lab'")
    expect(workflow).not.toContain("github.repository == 'mdev34-lab/silvercode'")
  })

  test("installer banner spells the product name", () => {
    const install = read("install")
    // The three-row block banner is drawn as half-cell art; the muted left half
    // spells SILVER and the highlighted right half spells CODE.
    const banner = install.split("\n").filter((line) => line.includes("${MUTED}") && line.includes("█"))
    expect(banner.length).toBeGreaterThanOrEqual(3)
    const art = banner.join("\n")
    expect(art).toContain("█▀▀▀ ▀██▀ █░░░ █░░█ █▀▀█ █▀▀█")
    expect(art).not.toContain("█▀▀█ █░░░ █▀▀█ █░░█ █▀▀█")
  })
})
