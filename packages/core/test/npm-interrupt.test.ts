import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Schedule } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

// Regression coverage for issue #271: a stalled registry install must be
// cancellable. These tests stand in for a stalled registry with a fake
// Arborist whose reify never settles on its own and rejects when its
// AbortSignal fires, mirroring make-fetch-happen's behavior.

const realArborist = await import("@npmcli/arborist")

type ArboristOptions = ConstructorParameters<typeof realArborist.Arborist>[0]

const fake = {
  armed: false,
  mode: "stall" as "stall" | "ok",
  reifyCalls: 0,
  signals: [] as AbortSignal[],
  entered: Promise.resolve(),
  enter: () => {},
}

const resetFake = (mode: "stall" | "ok") => {
  fake.armed = true
  fake.mode = mode
  fake.reifyCalls = 0
  fake.signals = []
  // Rendezvous so tests can wait until Arborist.reify was actually entered
  // before interrupting or joining, keeping the assertions deterministic.
  fake.entered = new Promise<void>((resolve) => {
    fake.enter = resolve
  })
}

class FakeArborist {
  opts: ArboristOptions
  constructor(opts: ArboristOptions) {
    this.opts = opts
  }
  reify(opts: ArboristOptions) {
    fake.reifyCalls += 1
    const signal = pickSignal(opts) ?? pickSignal(this.opts)
    if (signal) fake.signals.push(signal)
    fake.enter()
    if (fake.mode === "ok") return Promise.resolve({ edgesOut: new Map() })
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        { once: true },
      )
    })
  }
}

const pickSignal = (opts: unknown) =>
  typeof opts === "object" && opts !== null && "signal" in opts && opts.signal instanceof AbortSignal
    ? opts.signal
    : undefined

// bun:test module mocks are process-global and mock.restore() does not undo
// them, so this stand-in delegates to the real Arborist unless a test in this
// file explicitly arms the fake. Other test files (npm.test.ts) keep
// exercising the real install path even when they run after this one.
void mock.module("@npmcli/arborist", () => ({
  Arborist: function Arborist(opts: ArboristOptions) {
    if (fake.armed) return new FakeArborist(opts)
    return new realArborist.Arborist(opts)
  },
}))

afterEach(() => {
  fake.armed = false
})

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

const lockDirs = (state: string) =>
  Effect.promise(() =>
    fs
      .readdir(path.join(state, "locks"))
      .then((entries) => entries.filter((entry) => entry.endsWith(".lock")))
      .catch(() => [] as string[]),
  )

// Poll instead of reading once: NTFS/security scanners can lag directory
// removal briefly after the interrupted fiber released the lock. A truly
// unreleased lock still fails the test once the 3s budget expires.
const waitLocksReleased = (state: string) =>
  lockDirs(state).pipe(
    Effect.flatMap((dirs) =>
      dirs.length === 0 ? Effect.void : Effect.fail(new Error(`install lock still held: ${dirs.join(", ")}`)),
    ),
    Effect.retry({
      schedule: Schedule.spaced(100).pipe(Schedule.while((meta) => meta.elapsed < 3_000)),
      while: () => true,
    }),
  )

describe("Npm.install cancellation", () => {
  // 30s budget: the test runs two full install cycles (NpmConfig.load + flock
  // + reify each), which is far slower on Windows CI (NTFS + Defender) than
  // bun's 5s default allows.
  test("interrupting a stalled reify aborts the Arborist signal and releases the install lock", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const state = path.join(cache, "state")
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    resetFake("stall")

    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const fiber = yield* Effect.forkScoped(npm.install(dir, { add: [{ name: "stalled-pkg" }] }))
      yield* Effect.promise(() => fake.entered)
      expect(fake.reifyCalls).toBe(1)
      expect(fake.signals).toHaveLength(1)
      expect(fake.signals[0].aborted).toBe(false)

      yield* Fiber.interrupt(fiber)

      // Actual cancellation: the AbortSignal handed to Arborist (and through it
      // to pacote/npm-registry-fetch) fired, so in-flight registry work is
      // aborted instead of orphaned when the fiber is interrupted.
      expect(fake.signals[0].aborted).toBe(true)
      // Scope disposal: the flock acquired for this install directory was
      // released while unwinding the interrupted fiber.
      yield* waitLocksReleased(state)

      // The released lock is usable again: a follow-up install in the same
      // directory acquires it and completes without waiting on the stalled one.
      // Bounded so a lock-retry loop would fail the assertion instead of
      // burning the whole test budget.
      fake.mode = "ok"
      const exit = yield* npm
        .install(dir, { add: [{ name: "stalled-pkg" }] })
        .pipe(Effect.timeout(Duration.seconds(20)), Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(fake.reifyCalls).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
  }, 30_000)

  test("a successful reify receives a live signal and completes without aborting it", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const state = path.join(cache, "state")
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    resetFake("ok")

    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const fiber = yield* Effect.forkScoped(npm.install(dir, { add: [{ name: "healthy-pkg" }] }))
      yield* Effect.promise(() => fake.entered)
      yield* Fiber.join(fiber)
      // Normal installs are untouched by the cancellation wiring.
      expect(fake.signals).toHaveLength(1)
      expect(fake.signals[0].aborted).toBe(false)
      yield* waitLocksReleased(state)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
  }, 30_000)
})
