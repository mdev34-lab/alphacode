import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { makePartLock } from "../../src/session/part-lock"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
// A macrotask boundary drains pending promise reactions without assuming a
// fixed chain length. Cleanup assertions additionally await observable size.
const flush = Effect.promise(() => new Promise<void>((done) => setImmediate(done)))
const awaitEmpty = (lock: ReturnType<typeof makePartLock>) =>
  pollWithTimeout(
    Effect.sync(() => (lock.size() === 0 ? true : undefined)),
    "part lock did not clean up",
  )

it.live("part lock releases settled keys after success and failure", () =>
  Effect.gen(function* () {
    const lock = makePartLock()
    for (let i = 0; i < 100; i++) {
      yield* lock.withLock(String(i), Effect.void)
      yield* lock.withLock(String(i), Effect.fail("expected")).pipe(Effect.exit)
    }
    yield* awaitEmpty(lock)
    expect(lock.size()).toBe(0)
  }),
)

it.live("part lock keeps queued waiters serialized while older tails settle", () =>
  Effect.gen(function* () {
    const lock = makePartLock()
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const secondRelease = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const order: string[] = []
    const first = yield* lock
      .withLock(
        "part",
        Effect.gen(function* () {
          order.push("first")
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    const second = yield* lock
      .withLock(
        "part",
        Effect.gen(function* () {
          order.push("second")
          yield* Deferred.succeed(secondStarted, undefined)
          yield* Deferred.await(secondRelease)
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* lock.withLock(
      "other",
      Effect.sync(() => order.push("other")),
    )
    expect(order).toEqual(["first", "other"])
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(secondStarted)
    yield* Fiber.join(first)
    yield* flush
    expect(lock.size()).toBe(1)
    const third = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("third")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    expect(order).toEqual(["first", "other", "second"])
    yield* Deferred.succeed(secondRelease, undefined)
    yield* Fiber.join(second)
    yield* Fiber.join(third)
    yield* awaitEmpty(lock)
    expect(order).toEqual(["first", "other", "second", "third"])
    expect(lock.size()).toBe(0)
  }),
)

it.live("part lock cancellation of a queued waiter cannot bypass the active owner", () =>
  Effect.gen(function* () {
    const lock = makePartLock()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const order: string[] = []
    const owner = yield* lock
      .withLock(
        "part",
        Effect.gen(function* () {
          order.push("owner")
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    const cancelled = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("cancelled")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(cancelled)
    yield* flush
    expect(lock.size()).toBe(1)
    const next = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("next")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* flush
    expect(order).toEqual(["owner"])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(owner)
    yield* Fiber.join(next)
    yield* awaitEmpty(lock)
    expect(order).toEqual(["owner", "next"])
    expect(lock.size()).toBe(0)
  }),
)

it.live("part lock cancellation of active owner releases its waiter and cleans the key", () =>
  Effect.gen(function* () {
    const lock = makePartLock()
    const started = yield* Deferred.make<void>()
    const owner = yield* lock
      .withLock("part", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    const next = yield* lock.withLock("part", Effect.succeed("next")).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(owner)
    expect(yield* Fiber.join(next)).toBe("next")
    yield* awaitEmpty(lock)
    expect(lock.size()).toBe(0)
  }),
)

it.live("cancelling a middle waiter keeps a newer queued tail registered", () =>
  Effect.gen(function* () {
    const lock = makePartLock()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const order: string[] = []
    const owner = yield* lock
      .withLock("part", Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    const cancelled = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("cancelled")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    const next = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("next")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(cancelled)
    yield* flush
    expect(lock.size()).toBe(1)
    const last = yield* lock
      .withLock(
        "part",
        Effect.sync(() => order.push("last")),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* flush
    expect(order).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(owner)
    yield* Fiber.join(next)
    yield* Fiber.join(last)
    yield* awaitEmpty(lock)
    expect(order).toEqual(["next", "last"])
    expect(lock.size()).toBe(0)
  }),
)
