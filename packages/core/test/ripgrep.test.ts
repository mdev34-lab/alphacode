import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const effectIt = testEffect(LayerNode.compile(Ripgrep.node))
// The ripgrep binary bootstrap (PowerShell Expand-Archive) times out on
// Windows CI runners; skip until the extractor is fixed. See ripgrep.ts.
const it = effectIt

describe("Ripgrep", () => {
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "keeps ignored files out of catch-all find results",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
            yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"),
            )
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

            const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
            expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
            expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "excludes known generated and dependency directories by default",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"), { recursive: true }))
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "dist"), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "needle\n"))
            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "needle\n"),
            )
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "dist", "bundle.js"), "needle\n"))

            const ripgrep = yield* Ripgrep.Service
            const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*.js", limit: 10 })
            expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
            expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
            expect(files.map((item) => item.path)).not.toContain(RelativePath.make("dist/bundle.js"))

            const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "*.js", limit: 10 })
            expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make("src/index.js"))
            expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
            expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make("dist/bundle.js"))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "searches files inside excluded directories when cwd is the excluded directory",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const pkg = path.join(tmp.path, "node_modules", "pkg")
            yield* Effect.promise(() => fs.mkdir(pkg, { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(pkg, "index.js"), "needle\n"))

            const ripgrep = yield* Ripgrep.Service
            const files = yield* ripgrep.find({ cwd: pkg, pattern: "**/*.js", limit: 10 })
            expect(files.map((item) => item.path)).toEqual([RelativePath.make("index.js")])

            const matches = yield* ripgrep.grep({ cwd: pkg, pattern: "needle", include: "*.js", limit: 10 })
            expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("index.js")])
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "does not split surrogate pairs in oversized line previews",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
            )

            const matches = yield* (yield* Ripgrep.Service).grep({
              cwd: tmp.path,
              pattern: "needle",
              limit: 10,
            })

            expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )
})
