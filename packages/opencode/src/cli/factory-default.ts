import fs from "fs/promises"
import path from "path"
import { confirm, intro, isCancel, log, outro, spinner } from "@clack/prompts"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { UI } from "@/cli/ui"
import { errorMessage } from "@/util/error"

// Factory reset for the per-user state alphacode owns (config, data, state,
// cache). Project workspaces are never touched: any root that overlaps the
// current working directory is dropped from the plan, so an XDG override
// pointing into a project can never be wiped by running the flag there.
//
// Cache is wiped in contents mode: Global.Path.bin (install binaries for
// curl-installed builds) lives under the cache and must survive a reset,
// otherwise the running executable deletes itself out from under the user.

export interface FactoryDefaultTarget {
  label: string
  dir: string
  mode: "directory" | "contents"
  preserve?: string
}

export interface FactoryDefaultPlan {
  targets: FactoryDefaultTarget[]
}

export interface FactoryDefaultResult {
  removed: string[]
  failed: Array<{ path: string; error: string }>
}

const DOCS_URL = "https://github.com/mdev34-lab/alphacode#readme"

export function planFactoryDefault(input: { cwd: string; roots?: FactoryDefaultTarget[] }): FactoryDefaultPlan {
  const roots: FactoryDefaultTarget[] = input.roots ?? [
    { label: "Config", dir: Global.Path.config, mode: "directory" },
    { label: "Data", dir: Global.Path.data, mode: "directory" },
    { label: "State", dir: Global.Path.state, mode: "directory" },
    { label: "Cache", dir: Global.Path.cache, mode: "contents", preserve: Global.Path.bin },
  ]
  // Overlap in either direction is unsafe: a root inside the cwd would
  // delete project files, and a cwd inside a root would delete the
  // directory the process is running from.
  const targets = roots.filter((target) => !FSUtil.overlaps(input.cwd, target.dir))
  return { targets }
}

export async function applyFactoryDefault(plan: FactoryDefaultPlan): Promise<FactoryDefaultResult> {
  const result: FactoryDefaultResult = { removed: [], failed: [] }
  for (const p of await resolveRemovalPaths(plan)) {
    const err = await fs
      .rm(p, { recursive: true, force: true })
      .then(() => null)
      .catch((e) => e)
    if (err) result.failed.push({ path: p, error: errorMessage(err) })
    else result.removed.push(p)
  }
  return result
}

export async function runFactoryDefault(input: {
  yes?: boolean
  dryRun?: boolean
  cwd?: string
  roots?: FactoryDefaultTarget[]
}) {
  UI.empty()
  intro("Reset alphacode to factory defaults")

  const plan = planFactoryDefault({ cwd: input.cwd ?? process.cwd(), roots: input.roots })

  const present: FactoryDefaultTarget[] = []
  for (const target of plan.targets) {
    if (!(await exists(target.dir))) continue
    present.push(target)
    log.info(
      `  ${target.label}: ${shorten(target.dir)} ${UI.Style.TEXT_DIM}(${formatSize(await directorySize(target.dir))})`,
    )
  }

  if (present.length === 0) {
    log.info("Nothing to remove - alphacode is already at factory defaults")
    outro("Done")
    return
  }

  if (input.dryRun) {
    for (const p of await resolveRemovalPaths(plan)) {
      log.info(`  would remove ${shorten(p)}`)
    }
    log.warn("Dry run - no changes made")
    outro("Done")
    return
  }

  if (!input.yes) {
    if (!process.stdin.isTTY) {
      UI.error("--factory-default requires --yes when no interactive terminal is attached")
      process.exitCode = 1
      return
    }
    const confirmed = await confirm({
      message: "Remove all alphacode config, data, and cache? This cannot be undone.",
      initialValue: false,
    })
    if (!confirmed || isCancel(confirmed)) {
      outro("Cancelled")
      return
    }
  }

  const progress = spinner()
  progress.start("Removing alphacode user-level state...")
  const result = await applyFactoryDefault(plan)

  if (result.failed.length > 0) {
    progress.stop(`Finished with ${result.failed.length} error(s)`, 1)
    for (const failure of result.failed) {
      log.error(`  ${shorten(failure.path)}: ${failure.error}`)
    }
    process.exitCode = 1
  } else {
    progress.stop("Removed alphacode user-level state")
  }

  UI.empty()
  log.message(`alphacode rebuilds its state on next launch.\nDocs: ${DOCS_URL}`)
  outro("Done")
}

// Single source of truth for exactly which paths a reset deletes — both the
// dry-run listing and the actual removal go through this, so they can never
// disagree.
async function resolveRemovalPaths(plan: FactoryDefaultPlan): Promise<string[]> {
  const paths: string[] = []
  for (const target of plan.targets) {
    if (!(await exists(target.dir))) continue
    if (target.mode === "directory") {
      paths.push(target.dir)
      continue
    }
    const entries = await fs.readdir(target.dir).catch(() => [])
    for (const entry of entries) {
      const full = path.join(target.dir, entry)
      if (target.preserve && FSUtil.contains(target.preserve, full)) continue
      paths.push(full)
    }
  }
  return paths
}

function exists(p: string) {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false)
}

function shorten(p: string): string {
  const home = Global.Path.home
  if (p.startsWith(home)) return p.replace(home, "~")
  return p
}

async function directorySize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const stat = await fs.stat(full).catch(() => null)
      if (stat) total += stat.size
    }
  }
  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
