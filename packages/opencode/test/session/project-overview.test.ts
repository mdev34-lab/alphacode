import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ProjectOverview } from "../../src/session/project-overview"
import { tmpdir } from "../fixture/fixture"

describe("ProjectOverview.summarize", () => {
  test("describes a TypeScript monorepo with workspaces, package manager, and scripts", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "package.json"),
      JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
        scripts: { build: "tsup", test: "vitest", lint: "oxlint" },
        devDependencies: { typescript: "^5" },
      }),
    )
    await fs.writeFile(path.join(tmp.path, "bun.lock"), "{}")
    await fs.mkdir(path.join(tmp.path, "packages", "a"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "packages", "a", "package.json"), JSON.stringify({ name: "a" }))
    await fs.mkdir(path.join(tmp.path, "packages", "b"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "packages", "b", "package.json"), JSON.stringify({ name: "b" }))

    const block = ProjectOverview.summarize({ directory: tmp.path })
    expect(block).toBeDefined()
    expect(block).toContain("TypeScript monorepo (bun), 2 workspace packages")
    expect(block).toContain('build="tsup"')
    expect(block).toContain('test="vitest"')
    expect(block).toContain('lint="oxlint"')
    expect(block).toContain("<project>")
  })

  test("describes a plain Node project from a nested directory using the nearest manifest", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "package.json"),
      JSON.stringify({ name: "app", scripts: { test: "jest" } }),
    )
    await fs.writeFile(path.join(tmp.path, "package-lock.json"), "{}")
    await fs.mkdir(path.join(tmp.path, "src", "deep"), { recursive: true })

    const block = ProjectOverview.summarize({ directory: path.join(tmp.path, "src", "deep") })
    expect(block).toContain("JavaScript project (npm)")
    expect(block).toContain('test="jest"')
  })

  test("detects TypeScript via tsconfig without a typescript dependency", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "package.json"), JSON.stringify({ name: "app" }))
    await fs.writeFile(path.join(tmp.path, "tsconfig.json"), "{}")

    const block = ProjectOverview.summarize({ directory: tmp.path })
    expect(block).toContain("TypeScript project")
  })

  test("describes Python and Rust projects", async () => {
    await using py = await tmpdir()
    await fs.writeFile(path.join(py.path, "pyproject.toml"), "[project]\nname = \"demo\"\n")
    await fs.writeFile(path.join(py.path, "uv.lock"), "")
    expect(ProjectOverview.summarize({ directory: py.path })).toContain("Python project (uv)")

    await using rs = await tmpdir()
    await fs.writeFile(path.join(rs.path, "Cargo.toml"), "[package]\nname = \"demo\"\n")
    expect(ProjectOverview.summarize({ directory: rs.path })).toContain("Rust project")
  })

  test("includes the LSP server count when provided", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "package.json"), JSON.stringify({ name: "app" }))

    const block = ProjectOverview.summarize({ directory: tmp.path, lspServers: 2 })
    expect(block).toContain("LSP: 2 configured server(s)")
  })

  test("returns undefined when no software project is found", async () => {
    await using tmp = await tmpdir()
    const deep = path.join(tmp.path, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m")
    await fs.mkdir(deep, { recursive: true })
    expect(ProjectOverview.summarize({ directory: deep })).toBeUndefined()
  })

  test("reports the workspace package count cap with a plus sign", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    )
    for (let i = 0; i < 501; i++) {
      await fs.mkdir(path.join(tmp.path, "packages", `p${i}`), { recursive: true })
      await fs.writeFile(path.join(tmp.path, "packages", `p${i}`, "package.json"), JSON.stringify({ name: `p${i}` }))
    }
    const block = ProjectOverview.summarize({ directory: tmp.path })
    expect(block).toContain("500+ workspace packages")
  })
})
