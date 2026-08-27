import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RuntimeFlags } from "@opencode-ai/core/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const it = testEffect(RuntimeFlags.layer)

describe("RuntimeFlags", () => {
  it.effect("defaults factoryDefault to false", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      expect(flags.factoryDefault).toBe(false)
    }),
  )

  it.effect("layerWith overrides factoryDefault", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service.pipe(
        Effect.provide(RuntimeFlags.layerWith({ factoryDefault: true })),
      )
      expect(flags.factoryDefault).toBe(true)
    }),
  )
})
