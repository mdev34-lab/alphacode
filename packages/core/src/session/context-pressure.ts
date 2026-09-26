export * as SessionContextPressure from "./context-pressure"

import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SessionContext } from "@opencode-ai/schema/session-context"
import type { AgentV2 } from "../agent"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SystemContext } from "../system-context/index"
import { SessionContextReduction } from "./context-reduction"
import type { SessionSchema } from "./schema"

/**
 * The runtime's context-pressure nudge, delivered as system context.
 *
 * Reduction runs silently before every request: it never tells the model what it did. The pressure
 * source closes that loop without prompt markup. After each provider request the runner records
 * the report it published; on the next turn this source renders that report — utilization,
 * outcome, reclaimed tokens, limit — as model-visible context, so the agent can decide for itself
 * when finished work is worth compressing.
 *
 * The state is deliberately ephemeral: the last report per session, held in memory. A restart
 * simply has no pressure to report until the first request is measured again. There is no table,
 * no cache of projections, and no second derivation of utilization — the numbers are the ones the
 * runner already published.
 */

export interface Interface {
  readonly record: (sessionID: SessionSchema.ID, report: SessionContext.Report) => Effect.Effect<void>
  readonly load: (sessionID: SessionSchema.ID, agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionContextPressure") {}

const KEY = SystemContext.Key.make("core/context-pressure")

/** Fraction of the reduction threshold at which the agent is nudged before reduction starts. */
const NUDGE_FRACTION = 0.9

const shouldNudge = (report: SessionContext.Report, threshold: number) => {
  if (report.outcome === "reduced" || report.outcome === "exhausted") return true
  if (report.limit === undefined) return false
  return report.utilization >= threshold * NUDGE_FRACTION
}

const render = (report: SessionContext.Report) => {
  const percent = Math.round(report.utilization * 100)
  const limit = report.limit === undefined ? "unknown" : report.limit.toLocaleString("en-US")
  const tokens = report.tokens.toLocaleString("en-US")
  const reclaimed =
    report.reclaimedTokens > 0
      ? ` Reduction reclaimed ${report.reclaimedTokens.toLocaleString("en-US")} tokens from the request.`
      : ""
  return [
    `Context pressure: the last provider request used ${tokens} of ${limit} tokens (${percent}%, outcome: ${report.outcome}).${reclaimed}`,
    "When finished work no longer needs to be verbatim, call the compress tool with a focus string describing what to preserve (for example, the decisions made and the failing test) to replace it with a durable summary. Recent turns stay verbatim.",
  ].join(" ")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const documents = yield* (yield* Config.Service).entries()
    const threshold = SessionContextReduction.policy(documents).threshold
    const reports = yield* Ref.make(new Map<SessionSchema.ID, SessionContext.Report>())

    return Service.of({
      record: Effect.fn("SessionContextPressure.record")(function* (sessionID, report) {
        yield* Ref.update(reports, (current) => new Map(current).set(sessionID, report))
      }),
      load: Effect.fn("SessionContextPressure.load")(function* (sessionID, agent) {
        // A nudge for a tool the agent cannot call is pure overhead: the guidance must pay for
        // itself against the request it travels with.
        const permissions = agent.info?.permissions ?? []
        if (PermissionV2.evaluate("compress", "*", permissions).effect === "deny") return SystemContext.empty
        const report = (yield* Ref.get(reports)).get(sessionID)
        if (!report || !shouldNudge(report, threshold)) return SystemContext.empty
        return SystemContext.make({
          key: KEY,
          codec: Schema.toCodecJson(SessionContext.Report),
          load: Effect.succeed(report),
          baseline: render,
          update: (_previous, current) => render(current),
          removed: () => "Context pressure has eased. The previous context warning no longer applies.",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
