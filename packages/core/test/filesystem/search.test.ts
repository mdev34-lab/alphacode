import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const effectIt = testEffect(LayerNode.compile(Ripgrep.node))
// The ripgrep binary bootstrap (PowerShell Expand-Archive) times out on
// Windows CI runners; skip until the extractor is fixed. See ripgrep.ts.
const it = effectIt

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "globs exclude known generated and dependency directories by default",
    () =>
      withTmp((cwd) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "index.ts"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.ts"), "needle\n"))
          const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
          expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/index.ts")])
        }),
      ),
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})
