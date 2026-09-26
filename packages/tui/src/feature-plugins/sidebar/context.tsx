import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { contextUsage } from "../../util/context-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const cost = createMemo(() => props.api.state.session.get(props.session_id)?.cost ?? 0)
  // One derivation, shared with the prompt indicator: the runtime's own report when it has prepared
  // a request, the provider's accounting for the last assistant turn until it has.
  const usage = createMemo(() =>
    contextUsage({
      report: props.api.state.session.context(props.session_id),
      messages: props.api.state.session.messages(props.session_id),
      contextLimit: (providerID, modelID) =>
        props.api.state.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context,
    }),
  )

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{(usage()?.tokens ?? 0).toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{usage()?.percent ?? 0}% used</text>
      <Show when={usage()?.overhead}>
        {(overhead) => <text fg={theme().textMuted}>{overhead().toLocaleString()} tokens of prompt overhead</text>}
      </Show>
      <Show when={usage()?.reclaimed}>
        {(reclaimed) => <text fg={theme().textMuted}>{reclaimed().toLocaleString()} tokens reclaimed</text>}
      </Show>
      <Show when={usage()?.exhausted}>
        <text fg={theme().textMuted}>reduction exhausted</text>
      </Show>
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
