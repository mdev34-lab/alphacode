/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { createTuiAttention } from "../../../src/attention"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider, useData } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { useEvent } from "../../../src/context/event"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { createBuiltinPlugins } from "../../../src/feature-plugins/builtins"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../../src/keymap"
import { createTuiApi } from "../../../src/plugin/api"
import { createTuiApiAdapters } from "../../../src/plugin/adapters"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import type { HostSlots } from "../../../src/plugin/slots"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"

/**
 * AlphaCode docks the session sidebar on the left instead of the right.
 *
 * The harness mounts the real `<Session />` route inside the app's provider
 * tree, with the real builtin sidebar plugins registered through the plugin
 * runtime, and only mocks the HTTP boundary. Assertions read the rendered
 * character frame: the panel has to own the leftmost columns both when it is
 * docked (wide terminal) and when it is shown as an overlay (narrow terminal),
 * while its contents stay the same.
 */

const SESSION_ID = "ses_sidebar_left"
const SESSION_TITLE = "Sidebar placement session"
const MESSAGE_TEXT = "Where does the sidebar live?"
// Mirrors the fixed panel width in src/routes/session/sidebar.tsx.
const SIDEBAR_WIDTH = 42
const WIDE = 160
const NARROW = 100

type Setup = Awaited<ReturnType<typeof testRender>>
type Sync = ReturnType<typeof useSync>

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

function sessionPayload() {
  return {
    id: SESSION_ID,
    slug: "sidebar-placement",
    title: SESSION_TITLE,
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
  }
}

function messagesPayload() {
  const info: Message = {
    id: "msg_user",
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1_700_000_000_000 },
    agent: "work",
    model: { providerID: "test", modelID: "model" },
  }
  const part: TextPart = {
    id: "prt_text",
    sessionID: SESSION_ID,
    messageID: info.id,
    type: "text",
    text: MESSAGE_TEXT,
  }
  return [{ info, parts: [part] satisfies Part[] }]
}

function agentPayload() {
  return [{ name: "work", mode: "primary", description: "Test agent", permission: {}, options: {} }]
}

function pluginMeta(id: string): TuiPluginMeta {
  const now = Date.now()
  return {
    id,
    source: "internal",
    spec: id,
    target: id,
    first_time: now,
    last_time: now,
    time_changed: now,
    load_count: 1,
    fingerprint: id,
    state: "first",
  }
}

async function mountSession(width: number) {
  // Disposal is owned by `setups` so the tempdir outlives this function.
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json(agentPayload())
    if (url.pathname === "/api/agent")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: agentPayload() })
    if (url.pathname === `/session/${SESSION_ID}`) return json(sessionPayload())
    if (url.pathname === `/session/${SESSION_ID}/message`) return json(messagesPayload())
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  const pluginRuntime = createPluginRuntime()
  let sync!: Sync
  let plugins!: Promise<void>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  // Mirrors what the plugin host in packages/opencode does for internal
  // plugins: set the slot registry up with the real api, then activate the
  // builtin sidebar plugins against it.
  function SidebarPlugins() {
    const renderer = useRenderer()
    const tuiConfig = useTuiConfig()
    const kv = useKV()
    const dialog = useDialog()
    const keymap = useOpencodeKeymap()
    const route = useRoute()
    const event = useEvent()
    const sdk = useSDK()
    const storeSync = useSync()
    const data = useData()
    const theme = useTheme()
    const toast = useToast()
    const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
    onCleanup(() => attention.dispose())
    const api = createTuiApi(
      createTuiApiAdapters({
        version: InstallationVersion,
        tuiConfig,
        dialog,
        keymap,
        kv,
        route,
        routes: pluginRuntime.routes,
        event,
        sdk,
        sync: storeSync,
        data,
        theme,
        toast,
        renderer,
        attention,
        Slot: pluginRuntime.Slot,
      }),
    )
    const host = pluginRuntime.setupSlots(api)
    onCleanup(() => host.dispose())
    onMount(() => {
      sync = storeSync
      plugins = activateSidebarPlugins(api, host)
      done()
    })
    return <Session />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: SESSION_ID }}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={pluginRuntime}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <LocationProvider>
                          <EditorContextProvider>
                            <ExitProvider exit={() => {}}>
                              <EpilogueProvider set={() => {}}>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <SidebarPlugins />
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                    </ThemeProvider>
                                  </DataProvider>
                                </SyncProvider>
                              </EpilogueProvider>
                            </ExitProvider>
                          </EditorContextProvider>
                        </LocationProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </PluginRuntimeProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider>
        </OpencodeKeymapProvider>
      </ClipboardProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ home: "/tmp", state: tmp.path, worktree: directory }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width, height: 40 },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })
  await ready
  await plugins
  await until(() => sync.status === "complete")
  return { app, sync }
}

function activateSidebarPlugins(api: TuiPluginApi, host: HostSlots) {
  const builtins = createBuiltinPlugins({ experimentalEventSystem: false }).filter((plugin) =>
    plugin.id.startsWith("internal:sidebar"),
  )
  return Promise.all(
    builtins.map((plugin) => {
      let count = 0
      const slots: TuiPluginApi["slots"] = {
        register(views: TuiSlotPlugin) {
          const id = count ? `${plugin.id}:${count}` : plugin.id
          count += 1
          host.register({ ...views, id })
          return id
        },
      }
      const scoped: TuiPluginApi = { ...api, slots }
      return plugin.tui(scoped, undefined, pluginMeta(plugin.id))
    }),
  ).then(() => undefined)
}

async function until(fn: () => boolean, timeout = 15_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms`)
    await Bun.sleep(10)
  }
}

/** Pumps frames until `needle` is rendered, then returns that frame. */
async function frameWith(app: Setup, needle: string, passes = 600) {
  for (let pass = 0; pass <= passes; pass++) {
    const frame = app.captureCharFrame()
    if (frame.includes(needle)) return frame
    await app.renderOnce()
    await Bun.sleep(5)
  }
  throw new Error(`"${needle}" never rendered:\n${app.captureCharFrame()}`)
}

/** Column at which `needle` first appears, or -1 when it is not on screen. */
function columnOf(frame: string, needle: string) {
  for (const line of frame.split("\n")) {
    const column = line.indexOf(needle)
    if (column !== -1) return column
  }
  return -1
}

describe("session sidebar placement", () => {
  test("docks the sidebar against the left edge on a wide terminal", async () => {
    const session = await mountSession(WIDE)

    const frame = await frameWith(session.app, SESSION_TITLE)

    // The panel owns the leftmost columns and keeps its usual contents.
    expect(columnOf(frame, SESSION_TITLE)).toBeGreaterThanOrEqual(0)
    expect(columnOf(frame, SESSION_TITLE)).toBeLessThan(SIDEBAR_WIDTH)
    expect(columnOf(frame, "Context")).toBeLessThan(SIDEBAR_WIDTH)
    expect(columnOf(frame, "AlphaCode")).toBeLessThan(SIDEBAR_WIDTH)
    // The transcript starts to the right of the panel.
    expect(columnOf(frame, MESSAGE_TEXT)).toBeGreaterThan(SIDEBAR_WIDTH)
  })

  test("pins the overlay sidebar to the left edge on a narrow terminal", async () => {
    const session = await mountSession(NARROW)

    const closed = await frameWith(session.app, MESSAGE_TEXT)
    expect(closed.includes(SESSION_TITLE)).toBe(false)
    expect(columnOf(closed, MESSAGE_TEXT)).toBeLessThan(SIDEBAR_WIDTH)

    // <leader>b (ctrl+x then b) toggles the sidebar, same as in the real TUI.
    session.app.mockInput.pressKey("x", { ctrl: true })
    await session.app.renderOnce()
    session.app.mockInput.pressKey("b")

    const overlay = await frameWith(session.app, SESSION_TITLE)
    expect(columnOf(overlay, SESSION_TITLE)).toBeLessThan(SIDEBAR_WIDTH)
    expect(columnOf(overlay, "AlphaCode")).toBeLessThan(SIDEBAR_WIDTH)
    // The overlay panel is opaque and pinned left, so it covers the transcript
    // that was previously visible in those columns.
    expect(overlay.includes(MESSAGE_TEXT)).toBe(false)
  })
})
