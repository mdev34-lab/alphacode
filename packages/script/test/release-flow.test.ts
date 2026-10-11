import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { archiveName, archivePath } from "../src/artifacts"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const stubGh = path.join(import.meta.dir, "helpers", "gh-stub.bash")

const isWindows = process.platform === "win32"

/**
 * Fails with the subprocess output attached, so a red CI run shows the real
 * error instead of a bare exit-code diff.
 */
function expectOk(run: { exitCode: number; stdout: string; stderr: string }) {
  if (run.exitCode !== 0) {
    throw new Error(
      `expected exit code 0, got ${run.exitCode}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    )
  }
}

/** Git Bash, resolved once per call so the shim never depends on the ambient PATH. */
function bashForStub() {
  return (Bun.which("bash") ?? "bash").replace(/\\/g, "/")
}

/**
 * Installs the gh stub into `bin`.
 *
 * POSIX executes the bash script directly. Windows cannot exec a shebang
 * file, so no extensionless `gh` is written there at all (an exact-name match
 * would shadow PATHEXT lookup); instead `gh.cmd` hands the bash script to
 * Git Bash. Line endings are normalized so a CRLF checkout cannot corrupt
 * the script.
 */
async function installGhStub(bin: string) {
  const script = (await Bun.file(stubGh).text()).replace(/\r\n/g, "\n")
  if (isWindows) {
    const target = path.join(bin, "gh-stub.bash").replace(/\\/g, "/")
    await Bun.write(target, script)
    const shim = ["@echo off", `"${bashForStub()}" "${target}" %*`, ""].join("\r\n")
    await Bun.write(path.join(bin, "gh.cmd"), shim)
  } else {
    const target = path.join(bin, "gh")
    await Bun.write(target, script)
    Bun.spawnSync(["chmod", "+x", target])
  }
}

/** The command that invokes the stubbed gh on this platform. */
function ghCommand(bin: string, args: string[]) {
  if (isWindows) return [bashForStub(), path.join(bin, "gh-stub.bash").replace(/\\/g, "/"), ...args]
  return [path.join(bin, "gh"), ...args]
}

/**
 * Prepends `dir` to PATH inside `env`. The variable is spelled `Path` on
 * Windows and entries split on `;` there: reusing the existing key and the
 * platform delimiter is what lets the child find the stub at all.
 */
function withPathPrefix(env: Record<string, string>, dir: string) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH"
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` }
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

interface Sandbox {
  dir: string
  origin: string
  work: string
  state: string
  bin: string
  out: string
  cleanup: () => Promise<void>
}

async function makeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), "alphacode-release-flow-"))
  const origin = path.join(dir, "origin.git")
  const work = path.join(dir, "work")
  const state = path.join(dir, "ghstate")
  const bin = path.join(dir, "bin")
  const out = path.join(dir, "github-output.txt")
  await mkdir(state, { recursive: true })
  await mkdir(bin, { recursive: true })
  await installGhStub(bin)

  git(dir, "init", "--quiet", "--bare", origin)
  git(dir, "clone", "--quiet", origin, work)
  git(work, "config", "user.name", "AlphaCode Test")
  git(work, "config", "user.email", "alphacode-test@example.com")
  git(work, "checkout", "--quiet", "-b", "dev")
  await writeFile(path.join(work, "seed.txt"), "seed\n")
  git(work, "add", "--all")
  git(work, "commit", "--quiet", "-m", "chore: seed")
  git(work, "push", "--quiet", "-u", "origin", "dev")

  return {
    dir,
    origin,
    work,
    state,
    bin,
    out,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function flowEnv(sandbox: Sandbox, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const name of Object.keys(env)) {
    if (/^(ALPHACODE|OPENCODE)_/.test(name) || name.startsWith("GITHUB_")) delete env[name]
  }
  const pathed = withPathPrefix(env, sandbox.bin)
  return {
    ...pathed,
    GH_STUB_STATE: sandbox.state.replace(/\\/g, "/"),
    GH_STUB_ORIGIN: sandbox.origin.replace(/\\/g, "/"),
    GITHUB_ACTIONS: "true",
    GH_REPO: "stub/alphacode",
    GITHUB_OUTPUT: sandbox.out,
    RUNNER_TEMP: sandbox.dir,
    ...extra,
  }
}

async function runScript(sandbox: Sandbox, script: string, args: string[] = [], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", path.join(repoRoot, "script", script), ...args], {
    cwd: sandbox.work,
    stdout: "pipe",
    stderr: "pipe",
    env: flowEnv(sandbox, extra),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const runVersion = (sandbox: Sandbox, extra: Record<string, string> = {}) => runScript(sandbox, "version.ts", [], extra)
const runCleanup = (sandbox: Sandbox, tag: string) => runScript(sandbox, "release-cleanup.ts", [tag])

const remoteTagSha = (sandbox: Sandbox, tag: string) =>
  Bun.spawnSync(["git", `--git-dir=${sandbox.origin}`, "rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString().trim()

async function stubRelease(sandbox: Sandbox, tag: string) {
  const file = Bun.file(path.join(sandbox.state, "releases", `${tag}.json`))
  if (!(await file.exists())) return null
  return (await file.json()) as { tagName: string; databaseId: number; isDraft: boolean }
}

const stubLog = async (sandbox: Sandbox) => {
  const file = Bun.file(path.join(sandbox.state, "log"))
  return (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : []
}

async function gh(sandbox: Sandbox, ...args: string[]) {
  const proc = Bun.spawn(ghCommand(sandbox.bin, args), {
    cwd: sandbox.work,
    stdout: "pipe",
    stderr: "pipe",
    env: flowEnv(sandbox),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("release lifecycle with stubbed gh and a real git remote", () => {
  test(
    "pushes the tag before the draft exists, so the build job can check the tag out",
    async () => {
      const sandbox = await makeSandbox()
      try {
        const head = git(sandbox.work, "rev-parse", "HEAD")
        const run = await runVersion(sandbox)
        expectOk(run)

        // The ref exists on the remote immediately, pointing at the released commit.
        expect(remoteTagSha(sandbox, "v0.1.0")).toBe(head)

        // The release exists as a draft; the tag creation did not depend on it.
        const release = await stubRelease(sandbox, "v0.1.0")
        expect(release?.isDraft).toBe(true)

        const output = await readFile(sandbox.out, "utf8")
        expect(output).toContain("version=0.1.0")
        expect(output).toContain(`release_id=${release?.databaseId}`)
        expect(output).toContain("tag=v0.1.0")
        expect(output).toContain("repo=stub/alphacode")

        // The build job's checkout of the tag succeeds against the remote.
        const checkout = Bun.spawnSync(
          ["git", "clone", "--quiet", "--branch", "v0.1.0", sandbox.origin, path.join(sandbox.dir, "bld")],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect(checkout.exitCode).toBe(0)
        expect(git(path.join(sandbox.dir, "bld"), "tag", "--points-at", "HEAD")).toContain("v0.1.0")
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "a retried version job adopts the existing draft and tag instead of failing",
    async () => {
      const sandbox = await makeSandbox()
      try {
        const first = await runVersion(sandbox)
        expectOk(first)
        const second = await runVersion(sandbox)
        expectOk(second)

        const releases = (await stubLog(sandbox)).filter((line) => line.startsWith("release create"))
        expect(releases).toHaveLength(1)
        expect(second.stdout).toContain("adopting existing draft release v0.1.0")

        const firstId = (await readFile(sandbox.out, "utf8")).match(/release_id=(\d+)/)
        expect(firstId).not.toBeNull()
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "a published release can never be re-released",
    async () => {
      const sandbox = await makeSandbox()
      try {
        expectOk(await runVersion(sandbox))
        expectOk(await gh(sandbox, "release", "edit", "v0.1.0", "--draft=false", "--latest"))
        expect((await stubRelease(sandbox, "v0.1.0"))?.isDraft).toBe(false)

        const rerun = await runVersion(sandbox)
        expect(rerun.exitCode).not.toBe(0)
        expect(rerun.stderr).toContain("already published")
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "a version job failure after the tag push rolls the tag back",
    async () => {
      const sandbox = await makeSandbox()
      try {
        const failed = await runVersion(sandbox, { GH_STUB_FAIL_CREATE: "1" })
        expect(failed.exitCode).not.toBe(0)
        expect(remoteTagSha(sandbox, "v0.1.0")).toBe("")
        expect(await stubRelease(sandbox, "v0.1.0")).toBeNull()

        // The rolled-back run can be retried cleanly (local leftover tag is replaced).
        const retry = await runVersion(sandbox)
        expectOk(retry)
        expect(remoteTagSha(sandbox, "v0.1.0")).toBe(git(sandbox.work, "rev-parse", "HEAD"))
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "cleanup deletes a leftover draft release together with its tag, then a retry works",
    async () => {
      const sandbox = await makeSandbox()
      try {
        expectOk(await runVersion(sandbox))
        const cleanup = await runCleanup(sandbox, "v0.1.0")
        expectOk(cleanup)
        expect(cleanup.stdout).toContain("deleted draft release v0.1.0 and its tag")
        expect(await stubRelease(sandbox, "v0.1.0")).toBeNull()
        expect(remoteTagSha(sandbox, "v0.1.0")).toBe("")

        expectOk(await runVersion(sandbox))
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "cleanup deletes an orphan tag that has no release",
    async () => {
      const sandbox = await makeSandbox()
      try {
        git(sandbox.work, "tag", "v0.1.0")
        git(sandbox.work, "push", "--quiet", "origin", "refs/tags/v0.1.0")
        expect(remoteTagSha(sandbox, "v0.1.0")).not.toBe("")

        const cleanup = await runCleanup(sandbox, "v0.1.0")
        expectOk(cleanup)
        expect(cleanup.stdout).toContain("deleted orphan tag v0.1.0")
        expect(remoteTagSha(sandbox, "v0.1.0")).toBe("")
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "cleanup never touches a published release or its tag",
    async () => {
      const sandbox = await makeSandbox()
      try {
        expectOk(await runVersion(sandbox))
        expectOk(await gh(sandbox, "release", "edit", "v0.1.0", "--draft=false", "--latest"))

        const cleanup = await runCleanup(sandbox, "v0.1.0")
        expectOk(cleanup)
        expect(cleanup.stdout).toContain("published")
        expect((await stubRelease(sandbox, "v0.1.0"))?.isDraft).toBe(false)
        expect(remoteTagSha(sandbox, "v0.1.0")).not.toBe("")
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )

  test(
    "a tag pointing at another commit is a conflict, not an adoption",
    async () => {
      const sandbox = await makeSandbox()
      try {
        const head = git(sandbox.work, "rev-parse", "HEAD")
        await writeFile(path.join(sandbox.work, "other.txt"), "other\n")
        git(sandbox.work, "add", "--all")
        git(sandbox.work, "commit", "--quiet", "-m", "fix: move on")
        git(sandbox.work, "tag", "v0.1.0", head)
        git(sandbox.work, "push", "--quiet", "origin", "refs/tags/v0.1.0")

        const run = await runVersion(sandbox)
        expect(run.exitCode).not.toBe(0)
        expect(run.stderr).toContain(`Tag v0.1.0 already exists at ${head}`)
      } finally {
        await sandbox.cleanup()
      }
    },
    120_000,
  )
})

describe("release archive upload", () => {
  const allTargets = [
    { name: "alphacode-linux-arm64", os: "linux" },
    { name: "alphacode-linux-x64", os: "linux" },
    { name: "alphacode-linux-x64-baseline", os: "linux" },
    { name: "alphacode-linux-arm64-musl", os: "linux" },
    { name: "alphacode-linux-x64-musl", os: "linux" },
    { name: "alphacode-linux-x64-baseline-musl", os: "linux" },
    { name: "alphacode-darwin-arm64", os: "darwin" },
    { name: "alphacode-darwin-x64", os: "darwin" },
    { name: "alphacode-darwin-x64-baseline", os: "darwin" },
    { name: "alphacode-windows-arm64", os: "win32" },
    { name: "alphacode-windows-x64", os: "win32" },
    { name: "alphacode-windows-x64-baseline", os: "win32" },
  ]

  async function makeUploadSandbox() {
    const dir = await mkdtemp(path.join(tmpdir(), "alphacode-upload-"))
    const state = path.join(dir, "ghstate")
    const bin = path.join(dir, "bin")
    await mkdir(path.join(state, "releases"), { recursive: true })
    await mkdir(path.join(dir, "dist"), { recursive: true })
    await mkdir(bin, { recursive: true })
    await installGhStub(bin)
    await Bun.write(path.join(state, "releases", "v0.1.0.json"), '{"tagName":"v0.1.0","databaseId":1001,"isDraft":true}\n')
    return {
      dir,
      state,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    }
  }

  // Runs the upload through a subprocess so `gh` resolves from the stubbed PATH
  // (the sandbox never touches the real gh).
  async function runUpload(sandbox: { dir: string; state: string }, tag: string, archives: string[]) {
    const runner = [
      `import { uploadReleaseArchives } from ${JSON.stringify(path.join(repoRoot, "packages/script/src/artifacts.ts"))}`,
      `await uploadReleaseArchives(${JSON.stringify(tag)}, ${JSON.stringify(archives)}, "stub/alphacode")`,
    ].join("\n")
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    const proc = Bun.spawn(["bun", "-e", runner], {
      cwd: sandbox.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...withPathPrefix(env, path.join(sandbox.dir, "bin")), GH_STUB_STATE: sandbox.state.replace(/\\/g, "/") },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  test("linux targets are tarballs, every other target is a zip", () => {
    expect(archiveName({ name: "alphacode-linux-x64", os: "linux" })).toBe("alphacode-linux-x64.tar.gz")
    expect(archiveName({ name: "alphacode-darwin-arm64", os: "darwin" })).toBe("alphacode-darwin-arm64.zip")
    expect(archiveName({ name: "alphacode-windows-x64", os: "win32" })).toBe("alphacode-windows-x64.zip")
    expect(archivePath({ name: "alphacode-linux-x64", os: "linux" })).toBe("./dist/alphacode-linux-x64.tar.gz")
  })

  test("a single-target linux build uploads its tarball and never touches the zip glob", async () => {
    const sandbox = await makeUploadSandbox()
    try {
      const target = { name: "alphacode-linux-x64", os: "linux" }
      await Bun.write(path.join(sandbox.dir, "dist", archiveName(target)), "archive")
      const run = await runUpload(sandbox, "v0.1.0", [archivePath(target)])
      expectOk(run)
      const uploaded = await readFile(path.join(sandbox.state, "uploads"), "utf8")
      expect(uploaded.trim().split("\n")).toEqual(["./dist/alphacode-linux-x64.tar.gz"])
    } finally {
      await sandbox.cleanup()
    }
  })

  test("an all-targets build uploads exactly the twelve archives it produced", async () => {
    const sandbox = await makeUploadSandbox()
    try {
      const expected = allTargets.map(archivePath)
      for (const target of allTargets) {
        await Bun.write(path.join(sandbox.dir, "dist", archiveName(target)), "archive")
      }
      const run = await runUpload(sandbox, "v0.1.0", expected)
      expectOk(run)
      const uploaded = (await readFile(path.join(sandbox.state, "uploads"), "utf8")).trim().split("\n")
      expect(uploaded).toEqual(expected)
      expect(uploaded.filter((item) => item.endsWith(".tar.gz"))).toHaveLength(6)
      expect(uploaded.filter((item) => item.endsWith(".zip"))).toHaveLength(6)
    } finally {
      await sandbox.cleanup()
    }
  })

  test("a missing archive is a build failure, not a silent skip", async () => {
    const sandbox = await makeUploadSandbox()
    try {
      const run = await runUpload(sandbox, "v0.1.0", ["./dist/alphacode-linux-x64.tar.gz"])
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain("Release archive missing on disk: ./dist/alphacode-linux-x64.tar.gz")
    } finally {
      await sandbox.cleanup()
    }
  })
})
