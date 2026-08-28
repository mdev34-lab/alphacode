import { describe, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath, AbsolutePath } from "@opencode-ai/core/schema"
import { Entry } from "@opencode-ai/schema/filesystem"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"

const MAX_INDEX_FILES = 100_000
const testEnvironment = testEffect(Layer.empty)

const entries = Array.from({ length: MAX_INDEX_FILES + 1 }, (_, index) =>
  Entry.make({
    path: RelativePath.make(`dir/file-${index}.ts`),
    type: "file",
  }),
)

describe("FileSystemSearch index", () => {
  testEnvironment.live("marks an over-cap index incomplete without caching the extra entry", () => {
    let calls = 0
    const logs: string[] = []
    const fakeRipgrep = Layer.succeed(
      Ripgrep.Service,
      Ripgrep.Service.of({
        find: (input) =>
          Effect.gen(function* () {
            calls++
            if (input.onEntry) {
              for (let index = 0; index < input.limit; index++) {
                yield* input.onEntry(entries[index]!)
              }
            }
            return entries.slice(0, input.limit)
          }),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
      }),
    )
    const searchLayer = LayerNode.compile(FileSystem.node, [
      [Location.node, tempLocationLayer],
      [Ripgrep.node, fakeRipgrep],
    ])
    const captureLog = Logger.make((options) => {
      logs.push(String(options.message))
      return undefined
    })

    return Effect.gen(function* () {
      const service = yield* FileSystem.Service
      const result = yield* service.find({ query: "file-100000", type: "file", limit: 50 })

      expect(calls).toBe(1)
      expect(result).toHaveLength(0)
      expect(logs.some((message) => message.includes("incomplete"))).toBe(true)
    }).pipe(Effect.provide(Logger.layer([captureLog])), Effect.provide(searchLayer))
  })
})
