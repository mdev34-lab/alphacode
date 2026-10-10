import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// Primary presentation for #241: a single filling bar is the context
// indicator; the numeric token count/percent stay as an optional,
// accessibility-friendly detail underneath instead of the sole readout.
//
// Owner correction (post-review): there is no "confidently empty" status.
// Before any assistant message with real usage exists, the true state is
// UNKNOWN — we have not measured anything yet, so reporting "0 tokens /
// 0% used" would assert a fact we don't have. The same "unknown" status
// also covers the pre-existing case of usage existing but the model's
// context limit not being resolvable. Both render identically: a plain
// empty bar (no fill, no hatch/texture glyph) paired with the "usage
// unknown" text. A prior hatch-glyph ("▨") rendering for unknown was
// removed because that glyph's cell height renders differently from the
// fill/empty glyphs in terminal fonts, visually breaking the single-bar
// presentation the issue calls for.
//
// The percent formula here is intentionally the simplest possible one
// (last assistant message's own token total over its own model's context
// limit). Any notion of summing/aggregating usage across providers or
// models is explicitly out of scope and held pending the #243 spec, which
// owns context measurement/budget semantics; #241 must not invent that
// formula ahead of #243.
export const CONTEXT_BAR_WIDTH = 20

export type ContextUsage = { status: "known"; tokens: number; percent: number } | { status: "unknown"; tokens: number }

export function contextBarGlyphs(usage: ContextUsage): string {
  if (usage.status === "unknown") return "░".repeat(CONTEXT_BAR_WIDTH)
  const clamped = Math.max(0, Math.min(100, usage.percent))
  const filled = Math.round((clamped / 100) * CONTEXT_BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(CONTEXT_BAR_WIDTH - filled)
}

export function contextUsageFrom(messages: readonly AssistantMessage[], findModel: (providerID: string, modelID: string) => { limit: { context: number } } | undefined): ContextUsage {
  const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
  if (!last) return { status: "unknown", tokens: 0 }

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  const model = findModel(last.providerID, last.modelID)
  if (!model?.limit.context) return { status: "unknown", tokens }
  return { status: "known", tokens, percent: Math.round((tokens / model.limit.context) * 100) }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() =>
    contextUsageFrom(
      msg().filter((item): item is AssistantMessage => item.role === "assistant"),
      (providerID, modelID) => props.api.state.provider.find((item) => item.id === providerID)?.models[modelID],
    ),
  )

  const detail = createMemo(() => {
    const usage = state()
    if (usage.status === "unknown") return "usage unknown"
    return `${usage.tokens.toLocaleString()} tokens · ${usage.percent}% used`
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{contextBarGlyphs(state())}</text>
      <text fg={theme().textMuted}>{detail()}</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
