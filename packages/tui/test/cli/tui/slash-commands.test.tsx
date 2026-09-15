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

/**
 * The mounts below exercise the real session command registration path: the
 * `<Session />` route registers its commands on the keymap, and the slash
 * surface is read back through `useCommandSlashes`, the same derivation the
 * prompt autocomplete consumes. Nothing here inspects source text.
 */

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
  // Disposal is owned by `setups` so the tempdir outlives this function.
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
    if (
      [`/session/${SESSION_ID}/message`, `/session/${SESSION_ID}/todo`, `/session/${SESSION_ID}/diff`].includes(
        url.pathname,
      )
    ) {
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

    // The provider tree app.tsx mounts the route in, plus a probe that reads
    // the slash surface from inside the keymap context.
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

  // Pumps frames until the session commands have registered and the slash
  // surface derived from them is populated.
  for (let pass = 0; pass < 400; pass++) {
    await app.renderOnce()
    if (captured && captured.slashes().length > 0) return { app, ...captured }
    await Bun.sleep(5)
  }
  throw new Error("slash surface never populated")
}

function commandTitle(harness: Harness, name: string) {
  return harness.keymap.getCommands().find((command) => command.name === name)?.title
}

describe("session slash commands", () => {
  test("restores /details and /working on the commands they toggle", async () => {
    const harness = await mountSlashHarness()
    const entries = harness.slashes()

    const details = entries.find((entry) => entry.display === "/details")
    expect(details).toBeDefined()

    // Dispatching /details flips the tool-details toggle, proving it resolves
    // to session.toggle.actions rather than merely sharing a name with it.
    expect(commandTitle(harness, "session.toggle.actions")).toBe("Hide tool details")
    details?.onSelect()
    await harness.app.renderOnce()
    expect(commandTitle(harness, "session.toggle.actions")).toBe("Show tool details")
    // The canonical command ID drives the same implementation back.
    harness.keymap.dispatchCommand("session.toggle.actions")
    await harness.app.renderOnce()
    expect(commandTitle(harness, "session.toggle.actions")).toBe("Hide tool details")

    // /working is an alias of /activity, not a separate command, and it
    // dispatches the same activity toggle as the canonical command ID.
    const working = entries.find((entry) => entry.aliases?.includes("/working"))
    expect(working).toBeDefined()
    expect(working?.display).toBe("/activity")
    expect(commandTitle(harness, "session.toggle.activity")).toBe("Expand tool activity")
    working?.onSelect()
    await harness.app.renderOnce()
    expect(commandTitle(harness, "session.toggle.activity")).toBe("Collapse tool activity")
    harness.keymap.dispatchCommand("session.toggle.activity")
    await harness.app.renderOnce()
    expect(commandTitle(harness, "session.toggle.activity")).toBe("Expand tool activity")
  })

  test("surfaces every visible slash-bearing palette command in autocomplete", async () => {
    const harness = await mountSlashHarness()
    const entries = harness.slashes()

    const registered = harness.keymap
      .getCommandEntries({ namespace: "palette" })
      .map((entry) => entry.command)
      .filter((command) => command.hidden !== true && command.enabled !== false)
      .filter((command) => typeof command.slashName === "string" && command.slashName.length > 0)
    expect(registered.length).toBeGreaterThan(0)

    for (const command of registered) {
      const slashName = command.slashName
      if (typeof slashName !== "string" || slashName.length === 0) continue
      const entry = entries.find((item) => item.display === `/${slashName}`)
      expect(entry).toBeDefined()
      const expectedAliases = Array.isArray(command.slashAliases)
        ? command.slashAliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `/${alias}`)
        : []
      expect(entry?.aliases ?? []).toEqual(expectedAliases)
    }
  })
})
