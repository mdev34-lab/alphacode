/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { DialogAgentEffort } from "../../../src/component/dialog-agent-effort"
import { Prompt } from "../../../src/component/prompt"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider, parseModel, useLocal } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { DialogProvider } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { wait } from "../cmd/tui/sync-fixture"

type Setup = Awaited<ReturnType<typeof testRender>>

const SESSION_THOROUGH = "ses_effort_thorough"
const SESSION_FAST = "ses_effort_fast"
const SESSION_PLAIN = "ses_effort_plain"

function sessionRow(id: string, metadata?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    title: `Session ${id}`,
    projectID: "proj_test",
    version: "0.0.0-test",
    directory,
    time: { created: 0, updated: 0 },
    metadata,
  }
}

function agentsPayload(agentVariant?: string, model?: { providerID: string; modelID: string }) {
  return [
    {
      name: "build",
      mode: "primary",
      description: "Build agent",
      permission: {},
      options: {},
      // A configured agent variant only applies when the agent's configured
      // model is the active model, so the fixture pairs the variant with the
      // model the harness actually selects.
      ...(agentVariant && model ? { variant: agentVariant, model } : {}),
    },
  ]
}

function fullModel(id: string, name: string, variants?: Record<string, unknown>) {
  return {
    id,
    providerID: "test-provider",
    name,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...(variants ? { variants } : {}),
  }
}

function providersPayload() {
  return {
    providers: [
      {
        id: "test-provider",
        name: "TestProvider",
        source: "config",
        env: [],
        options: {},
        models: {
          "variant-model": fullModel("variant-model", "VariantModel", {
            low: { reasoning_effort: "low" },
            medium: { reasoning_effort: "medium" },
            high: { reasoning_effort: "high" },
          }),
          "plain-model": fullModel("plain-model", "PlainModel"),
        },
      },
    ],
    default: { "test-provider": "variant-model" },
  }
}

type Harness = {
  app: Setup
  local: ReturnType<typeof useLocal>
  route: ReturnType<typeof useRoute>
  sync: ReturnType<typeof useSync>
  updates: { sessionID: string; body: Record<string, unknown> }[]
  dispose: () => Promise<void>
}

async function mountEffort(input: {
  route: Route
  model: string
  children: () => JSX.Element
  agentVariant?: string
}): Promise<Harness> {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const events = createEventSource()
  const agentModel = parseModel(input.model)
  const sessions = [
    sessionRow(SESSION_THOROUGH, { agentEffort: "thorough", task: "keep-me" }),
    sessionRow(SESSION_FAST, { agentEffort: "fast", task: "keep-me" }),
    sessionRow(SESSION_PLAIN),
  ]
  const updates: { sessionID: string; body: Record<string, unknown> }[] = []

  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ agent: { effort: "fast" } })
    if (url.pathname === "/config/providers") return json(providersPayload())
    if (url.pathname === "/agent") return json(agentsPayload(input.agentVariant, agentModel))
    if (url.pathname === "/api/agent") {
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: agentsPayload(input.agentVariant, agentModel),
      })
    }
    if (url.pathname === "/session") return json(sessions)
    if (url.pathname.startsWith("/session/")) {
      const parts = url.pathname.split("/")
      const sessionID = parts[2]
      const suffix = parts[3]
      const row = sessions.find((item) => item.id === sessionID)
      if (suffix === "message" || suffix === "todo" || suffix === "diff") return json([])
      if (row) return json(row)
      return json({ id: sessionID })
    }
    return undefined
  }, events)

  // session.update is a PATCH whose body the URL-only fetch fixture cannot
  // see, so wrap it to capture and answer the metadata writes under test.
  const fetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
    const request = raw instanceof Request ? raw : new Request(raw, init)
    const url = new URL(request.url)
    if (request.method === "PATCH" && url.pathname.startsWith("/session/")) {
      const sessionID = url.pathname.slice("/session/".length)
      const body = (await request.clone().json()) as Record<string, unknown>
      updates.push({ sessionID, body })
      const row = sessions.find((item) => item.id === sessionID)
      return json(row ? { ...row, metadata: body.metadata ?? row.metadata } : { id: sessionID })
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch

  const config = createTuiResolvedConfig({})
  let captured: Pick<Harness, "local" | "route" | "sync"> | undefined
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Capture() {
    const local = useLocal()
    const route = useRoute()
    const sync = useSync()
    onMount(() => {
      captured = { local, route, sync }
      done()
    })
    return null
  }

  function Harness(props: { children: () => JSX.Element }) {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <ClipboardProvider>
        <OpencodeKeymapProvider keymap={keymap}>
          <ToastProvider>
            <RouteProvider initialRoute={input.route}>
              <TuiConfigProvider config={config}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
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
                                        <Capture />
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>{props.children()}</PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                      {/* Production mounts the toast surface on
                                          the home and session routes; the
                                          harness renders it directly so no-op
                                          toasts stay visible. */}
                                      <Toast />
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
        <ArgsProvider model={input.model}>
          <KVProvider>
            <Harness>{input.children}</Harness>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )

  await ready
  await wait(() => captured!.sync.status === "complete")

  return {
    app,
    local: captured!.local,
    route: captured!.route,
    sync: captured!.sync,
    updates,
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function frameWhere(app: Setup, predicate: (frame: string) => boolean, label: string) {
  for (let pass = 0; pass < 200; pass++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for frame: ${label}`)
}

function lineOf(frame: string, needle: string) {
  return frame.split("\n").find((line) => line.includes(needle)) ?? ""
}

function markerLine(frame: string) {
  return frame.split("\n").find((line) => line.includes("●")) ?? ""
}

describe("agent effort selector", () => {
  test("renders three levels with process meanings and the session's selection", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      expect(harness.local.effort.current()).toBe("thorough")
      const frame = await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(frame).toContain("Fast")
      expect(frame).toContain("Medium")
      expect(frame).toContain("Thorough")
      expect(frame).toContain("no review ritual")
      expect(frame).toContain("up to 2 review passes")
      expect(frame).toContain("review until clean")
      expect(frame).toContain("Stored on this session")
      expect(markerLine(frame)).toContain("Thorough")
    } finally {
      await harness.dispose()
    }
  })

  test("persists a selection on the active session and preserves unrelated metadata", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_FAST },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.effort.current()).toBe("fast")
      harness.app.mockInput.pressArrow("down")
      harness.app.mockInput.pressEnter()
      await wait(() => harness.updates.length >= 1, 3000)
      const [update] = harness.updates
      expect(update.sessionID).toBe(SESSION_FAST)
      expect(update.body.metadata).toEqual({ agentEffort: "medium", task: "keep-me" })
      // the pending write is visible immediately, before any sync event lands
      expect(harness.local.effort.current()).toBe("medium")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps selections isolated across session switches and no-ops on home", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      const first = await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(markerLine(first)).toContain("Thorough")

      harness.route.navigate({ type: "session", sessionID: SESSION_PLAIN })
      const switched = await frameWhere(harness.app, (f) => markerLine(f).includes("Fast"), "marker on plain session")
      expect(harness.local.effort.current()).toBe("fast")
      expect(switched).toContain("Stored on this session")

      harness.route.navigate({ type: "home" })
      await frameWhere(harness.app, (f) => f.includes("Config default"), "home footer")
      expect(harness.local.effort.current()).toBe("fast")
      harness.app.mockInput.pressEnter()
      await frameWhere(harness.app, (f) => f.includes("Agent effort applies per session"), "home toast")
      expect(harness.updates.length).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  test("labels effort in the prompt for models without thinking variants", async () => {
    const harness = await mountEffort({
      route: { type: "home" },
      model: "test-provider/plain-model",
      children: () => <Prompt />,
    })
    try {
      const frame = await frameWhere(harness.app, (f) => f.includes("PlainModel"), "prompt meta row")
      expect(lineOf(frame, "PlainModel")).toContain("fast")
      expect(harness.local.model.variant.list()).toEqual([])
      expect(harness.local.model.variant.current()).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  test("shows effort beside an explicit thinking choice and never clobbers it", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <Prompt />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("VariantModel"), "prompt meta row")
      harness.local.model.variant.set("high")
      await frameWhere(harness.app, (f) => lineOf(f, "VariantModel").includes("high"), "variant label")

      harness.local.effort.set("fast")
      await wait(() => harness.updates.length >= 1, 3000)
      expect(harness.updates[0].body.metadata).toEqual({ agentEffort: "fast", task: "keep-me" })
      expect(harness.local.effort.current()).toBe("fast")
      expect(harness.local.model.variant.current()).toBe("high")

      const after = await frameWhere(
        harness.app,
        (f) => {
          const line = lineOf(f, "VariantModel")
          return line.includes("fast") && line.includes("high")
        },
        "effort label beside thinking",
      )
      expect(after).toContain("· fast")
    } finally {
      await harness.dispose()
    }
  })

  test("applies the coupled thinking default only when nothing chose thinking", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.current()).toBeUndefined()

      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBe("low")
      harness.local.effort.set("thorough")
      expect(harness.local.model.variant.current()).toBe("high")

      // an explicit default/off selection is still a selection: no clobber
      harness.local.model.variant.set(undefined)
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBeUndefined()

      await wait(() => harness.updates.length >= 3, 3000)
      expect(harness.updates.map((update) => update.body.metadata)).toEqual([
        { agentEffort: "fast", task: "keep-me" },
        { agentEffort: "thorough", task: "keep-me" },
        { agentEffort: "fast", task: "keep-me" },
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("keeps a real selector choice from being re-coupled by effort changes", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      // A direct selector write becomes explicit provenance for this model.
      harness.local.model.variant.set("medium")
      expect(harness.local.model.variant.current()).toBe("medium")

      harness.local.effort.set("fast")
      // The dial must not re-couple `low` over the user's explicit choice.
      expect(harness.local.model.variant.current()).toBe("medium")
      expect(harness.local.model.variant.selected()).toBe("medium")

      harness.local.effort.set("thorough")
      expect(harness.local.model.variant.current()).toBe("medium")

      await wait(() => harness.updates.length >= 2, 3000)
      expect(harness.updates.map((update) => update.body.metadata)).toEqual([
        { agentEffort: "fast", task: "keep-me" },
        { agentEffort: "thorough", task: "keep-me" },
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("keeps a configured thinking variant when effort changes", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/variant-model",
      agentVariant: "high",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.current()).toBe("high")
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBe("high")
      expect(harness.local.model.variant.selected()).toBeUndefined()
      await wait(() => harness.updates.length >= 1, 3000)
      expect(harness.local.effort.current()).toBe("fast")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps behavior unchanged for models without thinking variants", async () => {
    const harness = await mountEffort({
      route: { type: "session", sessionID: SESSION_THOROUGH },
      model: "test-provider/plain-model",
      children: () => <DialogAgentEffort />,
    })
    try {
      await frameWhere(harness.app, (f) => f.includes("Agent effort"), "dialog title")
      expect(harness.local.model.variant.list()).toEqual([])
      harness.local.effort.set("fast")
      expect(harness.local.model.variant.current()).toBeUndefined()
      await wait(() => harness.updates.length >= 1, 3000)
      expect(harness.updates[0].body.metadata).toEqual({ agentEffort: "fast", task: "keep-me" })
      expect(harness.local.effort.current()).toBe("fast")
    } finally {
      await harness.dispose()
    }
  })
})
