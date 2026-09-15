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
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

const SESSION_ID = "ses_slash_commands"

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

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    keymapRef = keymap
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

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
      <TestTuiContexts directory={directory} paths={{ home: "/tmp", state: tmp.path, worktree: directory }}>
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
    if (keymapRef) return keymapRef
    await Bun.sleep(5)
  }
  throw new Error(`keymap never initialized:\n${app.captureCharFrame()}`)
}

describe("built-in slash command registration", () => {
  test("exposes the Working and tool-details commands through the canonical palette path", async () => {
    const keymap = await mountSession()
    const entries = keymap.getCommandEntries({
      visibility: "reachable",
      namespace: "palette",
    })

    const slashes = new Map(
      entries.flatMap((entry) => {
        const slashName = entry.command.slashName
        if (typeof slashName !== "string" || !slashName) return []
        return [[slashName, entry.command]] as const
      }),
    )

    expect(slashes.get("details")?.name).toBe("session.toggle.actions")
    expect(slashes.get("working")?.name).toBe("session.toggle.activity")
    expect(slashes.get("activity")?.name).toBe("session.toggle.activity")

    const working = slashes.get("working")
    expect(working?.slashAliases).toContain("activity")
  })
})
