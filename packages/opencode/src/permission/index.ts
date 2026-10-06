import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Duration, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

// Deliberately generous: long enough for a human watching the TUI to answer,
// short enough that an unattended run does not hang on a prompt nobody sees.
const DEFAULT_TIMEOUT_SECONDS = 45

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

// Outcomes a registered request can settle with. `DeniedError` is absent because a
// deny rule short-circuits `ask` before the request is ever published.
type ReplyError = PermissionV1.RejectedError | PermissionV1.CorrectedError | PermissionV1.TimedOutError

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, ReplyError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const timeout = (yield* config.get()).permission_timeout
      // On unless explicitly disabled: an unanswered prompt would otherwise pin the
      // session forever, which is what headless runs and subagents hit.
      const seconds = timeout?.enabled === false ? undefined : (timeout?.seconds ?? DEFAULT_TIMEOUT_SECONDS)

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
        expiresAt: seconds === undefined ? undefined : Date.now() + seconds * 1000,
      }
      yield* Effect.logInfo("asking", {
        id,
        permission: info.permission,
        patterns: info.patterns,
        expiresAt: info.expiresAt,
      })

      const deferred = yield* Deferred.make<void, ReplyError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      // Settles this request alone. A manual reject cascades to every pending request
      // in the session; a timeout must not, or one unanswered prompt would take down
      // unrelated tool calls that a human may still be about to answer.
      const expire = (waited: number) =>
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(waited * 1000))
          // A reply that claimed the request first completed the deferred in the same step
          // that removed it from `pending`, so losing the claim can never block here.
          if (!pending.delete(id)) return yield* Deferred.await(deferred)
          // Unlike `reply`, this fiber's lifetime is tied to the race below: completing the
          // deferred lets the ask resume, which interrupts whatever this fiber is still
          // doing. So the announcement goes out first and the completion is guaranteed by
          // `ensuring` — the entry is already out of `pending`, so a publish that fails or
          // is interrupted would otherwise leave the ask waiting on it forever.
          yield* Effect.ensuring(
            events.publish(Event.Replied, { sessionID: info.sessionID, requestID: id, reply: "timeout" }),
            Effect.sync(() => {
              Deferred.doneUnsafe(deferred, Effect.fail(new PermissionV1.TimedOutError({ seconds: waited })))
            }),
          )
          return yield* Deferred.await(deferred)
        })

      const wait = Deferred.await(deferred)
      // Racing interrupts the loser, so every reply path — and the instance dispose
      // finalizer — cancels the countdown without a separate timer handle.
      return yield* Effect.ensuring(
        seconds === undefined ? wait : Effect.raceFirst(wait, expire(seconds)),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      // A rejection carries the user's feedback when they typed any.
      const rejection =
        input.reply !== "reject"
          ? undefined
          : input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError()

      // Losing the claim means the countdown expired between the lookup above and here,
      // so the honest answer to the client is the same as for an unknown request.
      if (!(yield* settle(pending, existing, rejection)))
        return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        for (const item of pending.values()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          if (!(yield* settle(pending, item, new PermissionV1.RejectedError()))) continue
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
        }
        return
      }

      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const item of pending.values()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        if (!(yield* settle(pending, item, undefined))) continue
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

// Dropping an entry from `pending` and completing its deferred has to be one synchronous
// step. The countdown reads a missing entry as "a reply already settled this" and then
// awaits that deferred, and the instance dispose finalizer can only complete entries that
// are still in `pending`, so splitting the two around the interruptible `events.publish`
// would strand the ask forever when that publish fails or its fiber is interrupted.
// Returns whether this call won the claim.
function settle(pending: Map<PermissionV1.ID, PendingEntry>, entry: PendingEntry, error?: ReplyError) {
  return Effect.sync(() => {
    if (!pending.delete(entry.info.id)) return false
    Deferred.doneUnsafe(entry.deferred, error === undefined ? Effect.void : Effect.fail(error))
    return true
  })
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Config.node] })

export * as Permission from "."
