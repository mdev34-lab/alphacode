import fs from "fs/promises"
import os from "os"
import path from "path"
import { expect, test } from "bun:test"
import { applyFactoryDefault, planFactoryDefault, type FactoryDefaultTarget } from "../../src/cli/factory-default"

async function tmpRoot(label: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), `alphacode-factory-${label}-`))
}

function writeFile(file: string, content: string) {
  return fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, content))
}

function root(dir: string, mode: FactoryDefaultTarget["mode"] = "directory"): FactoryDefaultTarget {
  return { label: path.basename(dir), dir, mode, preserve: mode === "contents" ? path.join(dir, "bin") : undefined }
}

test("default plan covers config, data, state, and cache", () => {
  const plan = planFactoryDefault({ cwd: process.cwd() })
  expect(plan.targets.map((t) => t.label)).toEqual(["Config", "Data", "State", "Cache"])
  const cache = plan.targets.find((t) => t.label === "Cache")
  expect(cache?.mode).toBe("contents")
  expect(cache?.preserve).toBe(path.join(cache!.dir, "bin"))
})

test("plan drops roots that contain the working directory", async () => {
  const tmp = await tmpRoot("plan")
  const config = path.join(tmp, "config")
  const project = path.join(config, "project")

  const plan = planFactoryDefault({
    cwd: project,
    roots: [root(config), root(path.join(tmp, "data"))],
  })

  // The config root contains the project -> excluded; data survives.
  expect(plan.targets.map((t) => t.dir)).toEqual([path.join(tmp, "data")])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan keeps roots unrelated to the working directory", async () => {
  const tmp = await tmpRoot("plan-safe")
  const project = path.join(tmp, "project")

  const plan = planFactoryDefault({
    cwd: project,
    roots: [root(path.join(tmp, "config")), root(path.join(tmp, "data"))],
  })

  expect(plan.targets).toHaveLength(2)
  await fs.rm(tmp, { recursive: true, force: true })
})

test("apply removes directory-mode targets and skips missing paths", async () => {
  const tmp = await tmpRoot("apply")
  const config = path.join(tmp, "config")
  const missing = path.join(tmp, "missing")
  await writeFile(path.join(config, "opencode.json"), "{}")

  const result = await applyFactoryDefault({
    targets: [root(config), root(missing)],
  })

  expect(result.failed).toEqual([])
  expect(result.removed).toEqual([config])
  const survived = await Promise.all(
    [config, missing].map((p) =>
      fs.stat(p).then(
        () => true,
        () => false,
      ),
    ),
  )
  expect(survived).toEqual([false, false])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("apply wipes cache contents but preserves the bin subtree", async () => {
  const tmp = await tmpRoot("apply-cache")
  const cache = path.join(tmp, "cache")
  await writeFile(path.join(cache, "bin", "alphacode"), "binary")
  await writeFile(path.join(cache, "log", "app.log"), "log")
  await writeFile(path.join(cache, "stale.txt"), "stale")

  const result = await applyFactoryDefault({ targets: [root(cache, "contents")] })

  expect(result.failed).toEqual([])
  expect(result.removed.sort()).toEqual([path.join(cache, "log"), path.join(cache, "stale.txt")].sort())

  // The cache dir itself and the preserved bin subtree survive.
  expect(await fs.readFile(path.join(cache, "bin", "alphacode"), "utf8")).toBe("binary")
  await fs.rm(tmp, { recursive: true, force: true })
})

test("reset never deletes anything inside the working directory", async () => {
  const tmp = await tmpRoot("apply-cwd")
  const cache = path.join(tmp, "cache")
  const workdir = path.join(cache, "workspace")
  await writeFile(path.join(cache, "log", "app.log"), "log")
  await writeFile(path.join(workdir, "keep.txt"), "keep")

  // Plan from inside a directory that lives under a would-be root.
  const plan = planFactoryDefault({ cwd: workdir, roots: [root(cache, "contents")] })
  expect(plan.targets).toEqual([])

  const result = await applyFactoryDefault(plan)
  expect(result.removed).toEqual([])
  expect(result.failed).toEqual([])
  expect(await fs.readFile(path.join(workdir, "keep.txt"), "utf8")).toBe("keep")
  await fs.rm(tmp, { recursive: true, force: true })
})

test("apply enforces the workspace-safety invariant even when handed a plan directly", async () => {
  const tmp = await tmpRoot("apply-guard")
  const cache = path.join(tmp, "cache")
  const workdir = path.join(cache, "workspace")
  await writeFile(path.join(cache, "log", "app.log"), "log")
  await writeFile(path.join(cache, "bin", "alphacode"), "binary")
  await writeFile(path.join(workdir, "keep.txt"), "keep")

  // Deliberately bypass planFactoryDefault and hand apply a plan that
  // overlaps cwd -- apply must refuse to delete inside the working directory.
  const result = await applyFactoryDefault({ targets: [root(cache, "contents")] }, { cwd: workdir })

  expect(result.removed).toEqual([])
  expect(result.failed).toEqual([])
  expect(await fs.readFile(path.join(workdir, "keep.txt"), "utf8")).toBe("keep")
  expect(await fs.readFile(path.join(cache, "log", "app.log"), "utf8")).toBe("log")
  await fs.rm(tmp, { recursive: true, force: true })
})

test("apply keeps unrelated targets when the cwd guard filters out an overlapping one", async () => {
  const tmp = await tmpRoot("apply-mixed")
  const cache = path.join(tmp, "cache")
  const data = path.join(tmp, "data")
  const workdir = path.join(cache, "workspace")
  await writeFile(path.join(cache, "workspace", "keep.txt"), "keep")
  await writeFile(path.join(data, "gone.txt"), "gone")

  // cache overlaps cwd (dropped), data is unrelated (removed).
  const result = await applyFactoryDefault(
    { targets: [root(cache, "contents"), root(data)] },
    { cwd: workdir },
  )

  expect(result.removed).toEqual([data])
  expect(result.failed).toEqual([])
  expect(await fs.readFile(path.join(workdir, "keep.txt"), "utf8")).toBe("keep")
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan drops a root equal to the working directory", async () => {
  const tmp = await tmpRoot("plan-eq")
  const dir = path.join(tmp, "config")
  await fs.mkdir(dir, { recursive: true })

  const plan = planFactoryDefault({ cwd: dir, roots: [root(dir), root(path.join(tmp, "data"))] })

  expect(plan.targets.map((t) => t.dir)).toEqual([path.join(tmp, "data")])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan drops a working directory nested under a root with a trailing separator", async () => {
  const tmp = await tmpRoot("plan-trail")
  const config = path.join(tmp, "config") + path.sep
  const project = path.join(tmp, "config", "project")

  // Trailing separator on the root must not defeat the overlap check.
  const plan = planFactoryDefault({ cwd: project, roots: [root(config), root(path.join(tmp, "data"))] })

  expect(plan.targets.map((t) => t.dir)).toEqual([path.join(tmp, "data")])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan drops a root whose normalized form equals the working directory", async () => {
  const tmp = await tmpRoot("plan-dot")
  const config = path.join(tmp, "config")
  const dotConfig = path.join(config, "..", "config")

  const plan = planFactoryDefault({ cwd: config, roots: [root(dotConfig), root(path.join(tmp, "data"))] })

  expect(plan.targets.map((t) => t.dir)).toEqual([path.join(tmp, "data")])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan does not confuse sibling prefixes", async () => {
  const tmp = await tmpRoot("plan-sib")
  const config = path.join(tmp, "config")
  const sibling = path.join(tmp, "config2")

  // 'config2' is a sibling of the working directory, not a prefix overlap.
  const plan = planFactoryDefault({ cwd: config, roots: [root(sibling)] })

  expect(plan.targets.map((t) => t.dir)).toEqual([sibling])
  await fs.rm(tmp, { recursive: true, force: true })
})

test("plan keeps roots on a different Windows drive from the working directory", () => {
  if (process.platform !== "win32") return
  const plan = planFactoryDefault({
    cwd: "C:\\work\\project",
    roots: [root("D:\\config"), root("E:\\data")],
  })
  expect(plan.targets.map((t) => t.dir).sort()).toEqual(["D:\\config", "E:\\data"].sort())
})

test("plan treats Windows drive-letter casing as overlapping", () => {
  if (process.platform !== "win32") return
  // Same drive, different case -> still one filesystem namespace.
  const plan = planFactoryDefault({
    cwd: "C:\\work",
    roots: [root("c:\\work\\config")],
  })
  expect(plan.targets).toEqual([])
})
