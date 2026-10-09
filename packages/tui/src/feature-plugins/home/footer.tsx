import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Match, Show, Switch, type Accessor } from "solid-js"
import { displayWidth, truncateDisplay, truncateDisplayMiddle, truncateDisplayTail } from "../../prompt/display"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"

const id = "internal:home-footer"
const FOOTER_PADDING = 2
const FOOTER_GAP = 2
const MCP_GAP = 1

function fitLocation(directory: string | undefined, branch: string | undefined, version: string, maxWidth: number) {
  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0
  if (!directory) return truncateDisplay(version, width)

  const branchSuffix = branch ? `:${branch}` : ""
  const location = directory + branchSuffix
  if (!version) {
    if (displayWidth(location) <= width) return location
    if (displayWidth(directory) > width) return truncateDisplayTail(directory, width)
    return truncateDisplayMiddle(location, width)
  }

  const suffix = ` · ${version}`
  const suffixWidth = displayWidth(suffix)
  if (suffixWidth >= width) return truncateDisplay(version, width)

  const directoryWidth = width - suffixWidth
  if (displayWidth(directory) > directoryWidth) return truncateDisplayTail(directory, directoryWidth) + suffix
  return truncateDisplayMiddle(location, directoryWidth) + suffix
}

// Path and version share one centered text element, separated like the model settings in the prompt.
function Location(props: { api: TuiPluginApi; width: Accessor<number> }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const location = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return undefined
    const directory = abbreviateHome(selected.directory, paths.home)
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    return { directory, branch }
  })
  const text = createMemo(() => {
    const value = location()
    return fitLocation(value?.directory, value?.branch, props.api.app.version, props.width())
  })

  return (
    <box width={props.width()} flexShrink={0} alignItems="center" overflow="hidden">
      <text fg={theme().textMuted}>{text()}</text>
    </box>
  )
}

function Mcp(props: { api: TuiPluginApi; compact: Accessor<boolean> }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={props.compact() ? 0 : MCP_GAP} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <Show when={!props.compact()}>
          <text fg={theme().textMuted}>/status</text>
        </Show>
      </box>
    </Show>
  )
}

function View(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)
  const mcpLabelWidth = createMemo(() => displayWidth(`⊙ ${count()} MCP`))
  const fullMcpWidth = createMemo(() => mcpLabelWidth() + MCP_GAP + displayWidth("/status"))
  const minimumLocationWidth = displayWidth(`… · ${props.api.app.version}`)
  // On very narrow terminals keep the MCP count, but drop /status before it can be clipped.
  const compact = createMemo(
    () => has() && dimensions().width - 2 * FOOTER_PADDING - 2 * FOOTER_GAP < 2 * fullMcpWidth() + minimumLocationWidth,
  )
  const sideWidth = createMemo(() => {
    if (!has()) return 0
    return compact() ? mcpLabelWidth() : fullMcpWidth()
  })
  const locationWidth = createMemo(() =>
    Math.max(0, dimensions().width - 2 * FOOTER_PADDING - 2 * FOOTER_GAP - 2 * sideWidth()),
  )

  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={FOOTER_PADDING}
      paddingRight={FOOTER_PADDING}
      flexDirection="row"
      flexShrink={0}
      gap={FOOTER_GAP}
    >
      {/* Equal side widths preserve the footer's center while reserving enough room for MCP status. */}
      <box flexGrow={1} flexShrink={0} flexBasis={0} minWidth={sideWidth()}>
        <Mcp api={props.api} compact={compact} />
      </box>
      <Location api={props.api} width={locationWidth} />
      <box flexGrow={1} flexShrink={0} flexBasis={0} minWidth={sideWidth()} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
