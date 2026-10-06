import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

// One second is the shortest countdown the config accepts, so every test here outlives
// it: a request that is still pending afterwards proves the timer was cancelled rather
// than simply not fired yet.
const countdown = { permission_timeout: { enabled: true, seconds: 1 } }

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const bash = (id: string, session = "session_timeout") => ({
  id: PermissionV1.ID.make(id),
  sessionID: SessionID.make(session),
  permission: "bash",
  patterns: ["ls"],
  metadata: {},
  always: ["ls"],
  ruleset: [],
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    while (true) {
      const pending = yield* list()
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
    }),
  )

const rejectAll = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const request of yield* permission.list()) {
      yield* permission.reply({ requestID: request.id, reply: "reject" })
    }
  })

// Collects every `permission.replied` outcome so a test can assert the countdown never
// settled a request that a human already answered.
const collectReplies = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const replies: PermissionV1.ReplyOutcome[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === Permission.Event.Replied.type)
        replies.push((event.data as { reply: PermissionV1.ReplyOutcome }).reply)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return replies
  })

const waitForReplies = (replies: ReadonlyArray<unknown>, count: number) =>
  Effect.gen(function* () {
    while (replies.length < count) yield* Effect.sleep("10 millis")
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} permission replied event(s)`)),
    }),
  )

// Once a request leaves `pending` with its deferred still open, nothing can settle it any
// more: not a later reply, not the countdown, not the instance dispose finalizer. Fail
// loudly instead of hanging the suite for the full test timeout.
const notStranded = <A, E>(self: Effect.Effect<A, E>) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new Error("permission ask was never settled")),
    }),
  )

it.instance(
  "ask - auto-denies an unanswered prompt when the countdown expires",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const fiber = yield* ask(bash("per_timeout_expire")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      // Published on the request so every client renders the same countdown.
      const expiresAt = request.expiresAt ?? 0
      expect(expiresAt).toBeGreaterThan(Date.now())
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 1000)

      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) throw new Error("expected the unanswered prompt to be denied")
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(PermissionV1.TimedOutError)
      // A timeout must read differently from a rejection: the model should change
      // approach instead of treating it as the user saying no.
      if (error instanceof PermissionV1.TimedOutError) expect(error.message).toContain("automatically denied")

      expect(yield* list()).toHaveLength(0)
      yield* waitForReplies(replies, 1)
      // Clients dismiss the prompt off this event rather than polling for it.
      expect(replies).toEqual(["timeout"])
    }),
  { git: true, config: countdown },
)

it.instance(
  "ask - defaults to a 45 second countdown",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask(bash("per_timeout_default")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      const remaining = (request.expiresAt ?? 0) - Date.now()
      expect(remaining).toBeGreaterThan(43_000)
      expect(remaining).toBeLessThanOrEqual(45_000)

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

for (const answer of ["once", "always", "reject"] as const) {
  it.instance(
    `reply - ${answer} cancels the countdown`,
    () =>
      Effect.gen(function* () {
        const replies = yield* collectReplies()
        const fiber = yield* ask(bash("per_timeout_cancel")).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("per_timeout_cancel"), reply: answer })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(answer === "reject")

        yield* Effect.sleep("1200 millis")
        expect(replies).toEqual([answer])
        expect(yield* list()).toHaveLength(0)
      }),
    { git: true, config: countdown },
  )
}

it.instance(
  "ask - expiry settles only the request that ran out of time",
  () =>
    Effect.gen(function* () {
      const first = yield* ask(bash("per_timeout_first")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      // Start the second prompt late so its countdown is still running when the first one
      // expires. The stagger doubles as the slack the reply below has to land in, so this
      // test runs a longer countdown than the rest of the file.
      yield* Effect.sleep("2 seconds")
      const second = yield* ask(bash("per_timeout_second")).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      const exit = yield* Fiber.await(first)
      if (Exit.isSuccess(exit)) throw new Error("expected the first prompt to be denied")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.TimedOutError)

      // A manual reject cascades to every pending request in the session; a timeout
      // must not, or one unanswered prompt would take down tool calls a human is
      // still about to answer.
      expect((yield* waitForPending(1)).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_timeout_second")])

      yield* reply({ requestID: PermissionV1.ID.make("per_timeout_second"), reply: "once" })
      yield* Fiber.join(second)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: { permission_timeout: { enabled: true, seconds: 3 } } },
)

it.instance(
  "ask - arms the countdown in every session, including subagents",
  () =>
    Effect.gen(function* () {
      const parent = yield* ask(bash("per_timeout_parent", "session_parent")).pipe(Effect.forkScoped)
      const child = yield* ask(bash("per_timeout_child", "session_child")).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(2)
      expect(pending.every((item) => item.expiresAt !== undefined)).toBe(true)

      yield* rejectAll()
      yield* Effect.all([Fiber.await(parent), Fiber.await(child)])
    }),
  { git: true, config: countdown },
)

it.instance(
  "ask - enabled false waits for a human instead of counting down",
  () =>
    Effect.gen(function* () {
      const replies = yield* collectReplies()
      const fiber = yield* ask(bash("per_timeout_disabled")).pipe(Effect.forkScoped)

      const [request] = yield* waitForPending(1)
      expect(request.expiresAt).toBeUndefined()

      // Well past the one second countdown this instance is configured with, which
      // stays inert because the timeout is switched off.
      yield* Effect.sleep("1200 millis")
      expect(yield* list()).toHaveLength(1)
      expect(replies).toEqual([])

      yield* reply({ requestID: PermissionV1.ID.make("per_timeout_disabled"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true, config: { permission_timeout: { enabled: false, seconds: 1 } } },
)

// `permission.replied` is not a durable event, so publishing runs its listeners inline: a
// listener that dies fails the publish, and interrupting the publisher lands inside it.
// Both are the fault the claim has to survive, because at that point the entry is already
// out of `pending` — the state the countdown reads as "a reply settled this" and the
// dispose finalizer can no longer see.
it.instance(
  "reply - settles the ask when publishing the replied event fails",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.die(new Error("listener boom")) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask(bash("per_timeout_publish")).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const answered = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_publish"),
        reply: "once",
      }).pipe(Effect.exit)
      expect(Exit.isFailure(answered)).toBe(true)

      // The answer was applied before the publish was attempted, so the ask is already
      // done and the countdown has nothing left to expire.
      yield* notStranded(Fiber.join(fiber))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)

it.instance(
  "reply - settles the ask when the reply is interrupted mid-publish",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      // Hold the publish open so the reply can be interrupted after it claimed the
      // request but before it finished announcing it.
      const unsub = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type ? Effect.sleep("10 seconds") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask(bash("per_timeout_interrupt")).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const answering = yield* reply({
        requestID: PermissionV1.ID.make("per_timeout_interrupt"),
        reply: "once",
      }).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(answering)

      yield* notStranded(Fiber.join(fiber))
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true, config: countdown },
)
