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
  useOpencodeKeymap,
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

type Setup = Awaited<ReturnType<typeof testRender>>
type Harness = {
  app: Setup
  keymap: OpenTuiKeymap
  slashes: ReturnType<typeof useCommandSlashes>
}

const setups: { app: Setup; dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.app.renderer.destroy()
    await setup.dispose()
  }
})

async function mountSlashHarness(): Promise<Harness> {
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
        // A share url and revert keep /unshare and /redo enabled so the
        // inventory below covers the full registered surface, not just the
        // commands that happen to be enabled on a fresh session.
        share: { url: "https://test.share/ses_slash_commands" },
        revert: { messageID: "msg_reverted" },
      })
    }
    if (["message", "todo", "diff"].some((suffix) => url.pathname === `/session/${SESSION_ID}/${suffix}`)) {
      return json([])
    }
    return undefined
  }, events)

  const config = createTuiResolvedConfig({})
  let captured: Pick<Harness, "keymap" | "slashes"> | undefined

  function Capture() {
    captured = { keymap: useOpencodeKeymap(), slashes: useCommandSlashes() }
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <Capture />
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
    if (captured && captured.slashes().length > 0) return { app, ...captured }
    await Bun.sleep(5)
  }
  throw new Error("slash surface never populated")
}

const expectedSlashes = [
  ["/share"],
  ["/rename"],
  ["/timeline"],
  ["/fork"],
  ["/compact", "/summarize"],
  ["/unshare"],
  ["/undo"],
  ["/redo"],
  ["/timestamps", "/toggle-timestamps"],
  ["/thinking", "/toggle-thinking"],
  ["/details"],
  ["/activity", "/working"],
  ["/copy"],
  ["/export"],
] as const

describe("session slash commands", () => {
  test("registers the complete intended built-in slash surface", async () => {
    const harness = await mountSlashHarness()
    const actual = harness
      .slashes()
      .map((entry) => [entry.display, ...(entry.aliases ?? [])].sort().join(" "))
      .sort()

    const expected = expectedSlashes.map((entry) => [...entry].sort().join(" ")).sort()
    expect(actual).toEqual(expected)
  })

  test("dispatches /details and /working through their canonical commands", async () => {
    const harness = await mountSlashHarness()
    const entries = harness.slashes()

    const details = entries.find((entry) => entry.display === "/details")
    const working = entries.find((entry) => entry.aliases?.includes("/working"))
    expect(details).toBeDefined()
    expect(working?.display).toBe("/activity")

    const commandTitle = (name: string) => harness.keymap.getCommands().find((command) => command.name === name)?.title

    expect(commandTitle("session.toggle.actions")).toBe("Hide tool details")
    details?.onSelect()
    await harness.app.renderOnce()
    expect(commandTitle("session.toggle.actions")).toBe("Show tool details")

    expect(commandTitle("session.toggle.activity")).toBe("Expand tool activity")
    working?.onSelect()
    await harness.app.renderOnce()
    expect(commandTitle("session.toggle.activity")).toBe("Collapse tool activity")
  })
})
