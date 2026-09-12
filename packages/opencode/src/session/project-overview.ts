export * as ProjectOverview from "./project-overview"

import { existsSync, readFileSync } from "fs"
import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"

/** Cap on workspace package enumeration so huge monorepos stay cheap. */
const MAX_WORKSPACE_PACKAGES = 500

export interface Input {
  directory: string
  /** Count of enabled LSP servers from config; undefined when unknown. */
  lspServers?: number
}

/**
 * Renders a compact `<project>` block describing the workspace as a software
 * system for the Code agent. Pure filesystem observation: best-effort,
 * bounded, and safe to run on every provider turn. Returns undefined when no
 * recognizable software project is found, in which case callers omit the
 * block entirely.
 */
export function summarize(input: Input): string | undefined {
  const facts = collect(input)
  if (facts.length === 0) return undefined
  return ["<project>", "Software system overview (observed at turn start; verify before relying on it):", ...facts.map((fact) => `- ${fact}`), "</project>"].join("\n")
}

function collect(input: Input): string[] {
  const root = findManifestRoot(input.directory)
  if (root === undefined) return []
  const facts: string[] = []
  const stack = describeStack(root)
  if (stack) facts.push(`Stack: ${stack}`)
  const scripts = describeScripts(root)
  if (scripts) facts.push(`Scripts: ${scripts}`)
  if (input.lspServers && input.lspServers > 0) facts.push(`LSP: ${input.lspServers} configured server(s)`)
  return facts
}

/** Nearest ancestor (bounded) containing a project manifest, or undefined. */
function findManifestRoot(directory: string): string | undefined {
  let current = path.resolve(directory)
  for (let depth = 0; depth < 16; depth++) {
    if (
      existsSync(path.join(current, "package.json")) ||
      existsSync(path.join(current, "pyproject.toml")) ||
      existsSync(path.join(current, "Cargo.toml")) ||
      existsSync(path.join(current, "go.mod")) ||
      existsSync(path.join(current, "pom.xml")) ||
      existsSync(path.join(current, "build.gradle")) ||
      existsSync(path.join(current, "build.gradle.kts"))
    )
      return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function describeStack(root: string): string | undefined {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"))
  if (pkg) {
    const language = isTypeScript(root, pkg) ? "TypeScript" : "JavaScript"
    const workspaces = workspaceGlobs(pkg)
    if (workspaces.length === 0) return `${language} project${packageManager(root) ? ` (${packageManager(root)})` : ""}`
    const count = countPackages(root, workspaces)
    return `${language} monorepo${packageManager(root) ? ` (${packageManager(root)}` : ""}, ${count} workspace packages)`
  }
  if (existsSync(path.join(root, "pyproject.toml"))) return `Python project${lockMarker(root, ["uv.lock", "poetry.lock", "Pipfile.lock"]) ? ` (${lockMarker(root, ["uv.lock", "poetry.lock", "Pipfile.lock"])})` : ""}`
  if (existsSync(path.join(root, "Cargo.toml"))) return "Rust project"
  if (existsSync(path.join(root, "go.mod"))) {
    const module = goModule(path.join(root, "go.mod"))
    return `Go project${module ? ` (module ${module})` : ""}`
  }
  if (existsSync(path.join(root, "pom.xml"))) return "Java project (Maven)"
  if (existsSync(path.join(root, "build.gradle")) || existsSync(path.join(root, "build.gradle.kts"))) return "Java project (Gradle)"
  return undefined
}

interface PackageJson {
  name?: string
  workspaces?: string[] | { packages?: string[] }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function isTypeScript(root: string, pkg: PackageJson): boolean {
  if (existsSync(path.join(root, "tsconfig.json"))) return true
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  return deps.typescript !== undefined
}

function workspaceGlobs(pkg: PackageJson): string[] {
  const workspaces = pkg.workspaces
  if (!workspaces) return []
  if (Array.isArray(workspaces)) return workspaces
  return workspaces.packages ?? []
}

function countPackages(root: string, globs: string[]): number {
  const seen = new Set<string>()
  for (const glob of globs) {
    for (const match of Glob.scanSync(`${glob}/package.json`, { cwd: root })) {
      seen.add(path.resolve(root, match))
      if (seen.size >= MAX_WORKSPACE_PACKAGES) return MAX_WORKSPACE_PACKAGES
    }
  }
  return seen.size
}

function packageManager(root: string): string | undefined {
  if (existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb"))) return "bun"
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(path.join(root, "package-lock.json"))) return "npm"
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn"
  return undefined
}

function lockMarker(root: string, names: string[]): string | undefined {
  for (const name of names) {
    if (existsSync(path.join(root, name))) return name.split(".")[0]
  }
  return undefined
}

function goModule(file: string): string | undefined {
  try {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((item) => item.trimStart().startsWith("module "))
    return line?.trim().split(/\s+/)[1]
  } catch {
    return undefined
  }
}

function describeScripts(root: string): string | undefined {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"))
  if (!pkg?.scripts) return undefined
  const keys = ["build", "test", "lint", "typecheck"]
  const found = keys.filter((key) => typeof pkg.scripts?.[key] === "string")
  if (found.length === 0) return undefined
  return found.map((key) => `${key}="${pkg.scripts?.[key]}"`).join(", ")
}
