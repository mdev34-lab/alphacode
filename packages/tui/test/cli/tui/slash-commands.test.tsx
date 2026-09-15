/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import {
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useCommandSlashes,
  type OpenTuiKeymap,
} from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

const SESSION_ID = "ses_slash_commands"

type SlashEntry = { display: string; aliases?: string[]; onSelect: () => void }
const setups: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

async function mountSession() {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) {
      return json({
        id: SESSION_ID,
        slug: "slash-commands",
        title: "Slash commands",
        projectID: "proj_test",
        version: "0.0.0-test",
        directory,
        time: { created: 0, updated: 0 },
      })
    }
    if (url.pathname === `/session/${SESSION_ID}/message`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  let keymapRef: OpenTuiKeymap | undefined
  let slashRef: (() => readonly SlashEntry[]) | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    keymapRef = keymap
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    const slashes = useCommandSlashes()
    slashRef = () =>
      slashes().map((entry) => ({
        display: entry.display,
        aliases: entry.aliases,
        onSelect: entry.onSelect,
      }))

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: SESSION_ID }}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
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
                                                  <Session />
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
      <TestTuiContexts directory={directory} paths={{ home: tmp.path, state: tmp.path, worktree: directory }}>
        <ArgsProvider>
          <KVProvider>
            <Harness />
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )

  setups.push({ app, dispose: async () => await tmp[Symbol.asyncDispose]() })

  for (let pass = 0; pass < 400; pass++) {
    await app.renderOnce()
    if (keymapRef && slashRef) return { app, keymap: keymapRef, slashes: slashRef }
    await Bun.sleep(5)
  }
  throw new Error(`slash command state never initialized:\n${app.captureCharFrame()}`)
}

const expected = new Map([
  ["/share", []],
  ["/rename", []],
  ["/timeline", []],
  ["/fork", []],
  ["/compact", ["/summarize"]],
  ["/compress", []],
  ["/unshare", []],
  ["/undo", []],
  ["/redo", []],
  ["/copy", []],
  ["/export", []],
  ["/timestamps", ["/toggle-timestamps"]],
  ["/thinking", ["/toggle-thinking"]],
  ["/details", []],
  ["/activity", ["/working"]],
])

describe("built-in slash command autocomplete", () => {
  test("exposes the complete built-in surface through canonical command registration", async () => {
    const { slashes } = await mountSession()
    const entries = slashes()

    expect(new Set(entries.map((entry) => entry.display))).toEqual(new Set(expected.keys()))

    for (const [display, aliases] of expected) {
      const entry = entries.find((item) => item.display === display)
      expect(entry?.aliases ?? []).toEqual(aliases)
    }
  })

  test("dispatches an alias through the canonical command implementation", async () => {
    const { app, keymap, slashes } = await mountSession()
    const activity = slashes().find((entry) => entry.aliases?.includes("/working"))
    expect(activity).toBeDefined()

    const before = keymap.getCommands().find((command) => command.name === "session.toggle.activity")
    expect(before?.title).toBe("Expand tool activity")

    activity?.onSelect()
    await app.renderOnce()

    const after = keymap.getCommands().find((command) => command.name === "session.toggle.activity")
    expect(after?.title).toBe("Collapse tool activity")
  })
})
