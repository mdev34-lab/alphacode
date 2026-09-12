import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { reviewLoopState } from "@opencode-ai/core/review-loop"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  const reviewStatus = createMemo(() => {
    if (route.data.type !== "session") return undefined
    const sessionID = route.data.sessionID
    const reviewConfig = sync.data.config as unknown as { review_loop?: { max_iterations?: number } }
    const maxIterations = reviewConfig.review_loop?.max_iterations ?? 5
    const messages = (sync.data.message[sessionID] ?? []).map((message) => ({
      role: message.role,
      parts: sync.data.part[message.id] ?? [],
    }))
    const state = reviewLoopState(messages, maxIterations)
    const busy = sync.data.session_status[sessionID]?.type === "busy"

    if (state.reviews === 0 && state.termination === undefined && !busy) return undefined
    return state
  })

  const [store, setStore] = createStore({ welcome: false })

  onMount(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = []
    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }
      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))
    onCleanup(() => timeouts.forEach(clearTimeout))
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Show when={reviewStatus()}>
          {(status) => (
            <text
              fg={
                status().termination === "approved"
                  ? theme.success
                  : status().termination === "review-cap" || status().termination === "skipped"
                    ? theme.warning
                    : theme.text
              }
            >
              Review {status().reviews}/{status().maxIterations} ·{" "}
              {status().termination === "approved"
                ? "approved"
                : status().termination === "review-cap"
                  ? "cap"
                  : status().termination === "skipped"
                    ? "skipped"
                    : status().phase}
            </text>
          )}
        </Show>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
