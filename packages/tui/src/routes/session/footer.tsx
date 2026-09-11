import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"

const REVIEW_READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "lsp",
  "tool_search",
  "tool_search_regex",
  "question",
  "todo",
])

function reviewVerdict(output: unknown) {
  if (typeof output !== "string") return undefined
  const matches = [...output.matchAll(/\*\*Ready to proceed\?\*\*\s*(?:\[[^\]]*\]\s*)?(Approved|Needs fixes)\b/gi)]
  const verdict = matches.at(-1)?.[1]
  if (!verdict) return undefined
  return verdict.toLowerCase() === "approved" ? "approved" : "needs-fixes"
}

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
    const messages = sync.data.message[sessionID] ?? []
    const parts = messages.flatMap((message) => sync.data.part[message.id] ?? [])
    const reviewConfig = sync.data.config as unknown as { review_loop?: { max_iterations?: number } }
    const maxIterations = reviewConfig.review_loop?.max_iterations ?? 5

    let reviews = 0
    let latestReview: "approved" | "needs-fixes" | undefined
    let reviewRunning = false
    let phase: "work" | "review" = "work"
    let termination: "approved" | "review-cap" | undefined

    for (const part of parts) {
      if (part.type !== "tool") continue

      if (part.tool === "task") {
        const input = part.state.input as Record<string, unknown>
        if (input.subagent_type !== "review" || input.background !== false) continue
        if (part.state.status === "running" || part.state.status === "pending") {
          reviewRunning = true
          phase = "review"
          continue
        }
        if (part.state.status === "completed") {
          reviews++
          latestReview = reviewVerdict(part.state.output)
          phase = "work"
        }
        continue
      }

      if (part.tool === "finish") {
        if (part.state.status !== "completed") continue
        const metadata = part.state.metadata as Record<string, unknown> | undefined
        const review = metadata?.review as Record<string, unknown> | undefined
        if (review?.termination === "approved") termination = "approved"
        if (review?.termination === "review-cap") termination = "review-cap"
        continue
      }

      if (!REVIEW_READ_ONLY_TOOLS.has(part.tool)) phase = "work"
    }

    const busy = sync.data.session_status[sessionID]?.type === "busy"
    if (!busy && termination) phase = termination === "approved" ? "review" : "work"
    if (reviewRunning) phase = "review"
    if (latestReview === "needs-fixes" && busy && !reviewRunning) phase = "work"

    if (reviews === 0 && termination === undefined && !busy) return undefined
    return {
      reviews,
      maxIterations,
      phase,
      termination,
    }
  })

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
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
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Show when={reviewStatus()}>
          {(status) => (
            <text fg={status().termination === "approved" ? theme.success : status().termination === "review-cap" ? theme.warning : theme.text}>
              Review {status().reviews}/{status().maxIterations} · {status().termination === "approved" ? "approved" : status().termination === "review-cap" ? "cap" : status().phase}
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
