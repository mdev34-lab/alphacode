/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createMemo, createSignal, For, Match, Switch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { AssistantMessage, Message, Part, Provider, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { RouteProvider } from "../../../src/context/route"
import { LocalProvider } from "../../../src/context/local"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { LocationProvider } from "../../../src/context/location"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { ActivityGroup, AssistantMessageRow, SessionContext } from "../../../src/routes/session"
import { computeActivityGroups } from "../../../src/util/activity"

const SESSION = "ses_activity_ui"
const BASE = 1_700_000_000_000
const at = (offset: number) => BASE + offset * 1000

let partCounter = 0
const nextPartID = () => `prt_${String(++partCounter).padStart(3, "0")}`

function assistant(id: string, created: number) {
  return {
    id,
    sessionID: SESSION,
    role: "assistant" as const,
    time: { created, completed: created + 1000 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "tool-calls",
  }
}

function textPart(messageID: string, value: string): TextPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "text", text: value }
}

function reasoningPart(messageID: string, value: string): ReasoningPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "reasoning", text: value, time: { start: at(0) } }
}

function toolPart(messageID: string, tool: string, input: Record<string, unknown>, state: ToolPart["state"]): ToolPart {
  return { id: nextPartID(), sessionID: SESSION, messageID, type: "tool", callID: "call", tool, state }
}

function running(messageID: string, tool: string, input: Record<string, unknown>, start: number): ToolPart {
  return toolPart(messageID, tool, input, { status: "running", input, time: { start } })
}

function completed(part: ToolPart, start: number, end: number): ToolPart {
  return {
    ...part,
    state: { status: "completed", input: part.state.input, output: "", title: "", metadata: {}, time: { start, end } },
  }
}

async function waitUntil(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

let testSetup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined
type Sync = ReturnType<typeof useSync>

afterEach(async () => {
  await testSetup?.dispose()
  testSetup = undefined
})

function seed(sync: Sync, rows: { message: Message; parts: Part[] }[]) {
  sync.set("message", SESSION, rows.map((row) => row.message))
  for (const row of rows) {
    if (row.parts.length) sync.set("part", row.message.id, row.parts)
  }
}

function reseedParts(sync: Sync, partsByMessage: Record<string, Part[]>) {
  for (const [messageID, parts] of Object.entries(partsByMessage)) sync.set("part", messageID, parts)
}

function frameOf(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().split("\n").map((line) => line.trimEnd()).join("\n")
}

function rowOf(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(needle))
  if (row === -1) throw new Error(`needle "${needle}" not found in frame:\n${frame}`)
  return row
}

function findGroup(sync: Sync): string | undefined {
  const rows = (sync.data.message[SESSION] ?? []).map((message) => ({
    message,
    parts: sync.data.part[message.id] ?? [],
  }))
  return [...computeActivityGroups(rows).byID.values()].find((group) => group.items.length > 1)?.id
}

function Transcript() {
  const sync = useSync()
  return (
    <For each={sync.data.message[SESSION] ?? []}>
      {(message) => (
        <Switch>
          <Match when={message.role === "user"}>
            <text>
              {(sync.data.part[message.id] ?? []).filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join(" ")}
            </text>
          </Match>
          <Match when={true}>
            <AssistantMessageRow
              message={message as AssistantMessage}
              parts={sync.data.part[message.id] ?? []}
              last={false}
            />
          </Match>
        </Switch>
      )}
    </For>
  )
}

async function mountActivity(options: {
  height?: number
  width?: number
  render?: (sync: Sync) => JSX.Element
} = {}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync
  let scroll: ScrollBoxRenderable | undefined
  const [allExpanded, setAllExpanded] = createSignal(false)
  const [overrides, setOverrides] = createStore<Record<string, boolean | undefined>>({})
  const isExpanded = (groupID: string) => allExpanded() || overrides[groupID] === true

  function KeymapBindings() {
    const tui = useTuiConfig()
    useBindings(() => ({
      commands: [
        {
          namespace: "palette",
          name: "session.toggle.activity",
          title: "Expand tool activity",
          run: () => {
            setAllExpanded((value) => !value)
            // setStore merges, so clearing requires removing every key.
            for (const key of Object.keys(overrides)) setOverrides(key, undefined)
          },
        },
      ],
    }))
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      bindings: tui.keybinds.gather("session", ["session.toggle.activity"]),
    }))
    return <></>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const tui = useTuiConfig()
    const off = registerOpencodeKeymap(keymap, renderer, tui)
    onCleanup(off)

    const storeSync = useSync()
    sync = storeSync
    const activity = createMemo(() =>
      computeActivityGroups(
        (storeSync.data.message[SESSION] ?? []).map((message) => ({
          message,
          parts: storeSync.data.part[message.id] ?? [],
        })),
      ),
    )
    const ctxValue = {
      get width() {
        return options.width ?? 100
      },
      sessionID: SESSION,
      conceal: () => true,
      thinkingMode: () => "hide" as const,
      showThinking: () => true,
      showTimestamps: () => false,
      showDetails: () => true,
      showGenericToolOutput: () => false,
      diffWrapMode: () => "word" as const,
      providers: () => new Map<string, Provider>(),
      sync: storeSync,
      tui,
      activity: () => activity(),
      activityAllExpanded: () => allExpanded(),
      activityExpanded: isExpanded,
      toggleActivity: (groupID: string) => setOverrides(groupID, isExpanded(groupID) ? undefined : true),
    }
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <KeymapBindings />
        <SessionContext.Provider value={ctxValue}>
          <LocationProvider location={{ directory: "/tmp", workspaceID: undefined }}>
            <scrollbox ref={(r) => (scroll = r)} height={options.height ?? 24} width={options.width ?? 100}>
              {options.render ? options.render(storeSync) : <Transcript />}
            </scrollbox>
          </LocationProvider>
        </SessionContext.Provider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory="/tmp"
        paths={{
          home: "/tmp",
          state,
          worktree: "/tmp",
        }}
      >
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID: SESSION }}>
                  <TuiConfigProvider config={createTuiResolvedConfig()}>
                    <SDKProvider url="http://test" directory="/tmp" fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <Harness />
                              </LocalProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: options.width ?? 100, height: options.height ?? 24, kittyKeyboard: true },
  )

  testSetup = { app, dispose: async () => { await tmp[Symbol.asyncDispose]() } }
  // The KV provider renders its children only once KV state has loaded, so
  // wait until the harness (and its sync handle) has actually mounted.
  await waitUntil(() => sync !== undefined)
  await app.renderOnce()
  return {
    app,
    sync,
    scroll: () => scroll,
  }
}

function twoRunningTools() {
  const m1 = assistant("m1", at(1))
  const m2 = assistant("m2", at(2))
  const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
  const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
  return { m1, m2, t1, t2 }
}

describe("activity group TUI", () => {
  test("shows a compact working header for a run of tool calls", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [textPart(m1.id, "I will investigate this."), t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls"))

      const frame = frameOf(app)
      expect(frame).toContain("Working... 2 tool calls")
      expect(frame).toContain("▸")
      // Collapsed: no tool detail rows leak into the conversation.
      expect(frame).not.toContain("Read src/a.ts")
      expect(frame).not.toContain("Grep")
    } finally {
      app.renderer.destroy()
    }
  })

  test("streams new tool calls into the same group", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls"))

      const t3 = running(m2.id, "bash", { command: "bun test" }, 1200)
      reseedParts(sync, { [m2.id]: [t2, t3] })
      await app.waitForFrame((frame: string) => frame.includes("Working... 3 tool calls"))
      expect(frameOf(app)).toContain("Working... 3 tool calls")
    } finally {
      app.renderer.destroy()
    }
  })

  test("click expands the group to native tool rows and collapses again", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls"))

      const row = rowOf(frameOf(app), "Working... 2 tool calls")
      await app.mockMouse.click(5, row)
      await app.waitForFrame((frame: string) => frame.includes("Read src/a.ts") && frame.includes('Grep "todo"'))
      expect(frameOf(app)).toContain("▾")

      await app.mockMouse.click(5, rowOf(frameOf(app), "Working... 2 tool calls"))
      await app.waitForFrame((frame: string) => !frame.includes("Read src/a.ts"))
      expect(frameOf(app)).toContain("▸")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows a completed summary with duration and count", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls"))

      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 4200)], [m2.id]: [completed(t2, 1100, 5200)] })
      await app.waitForFrame((frame: string) => frame.includes("Worked for 4.2s · 2 tool calls"))
      expect(frameOf(app)).not.toContain("Working...")
    } finally {
      app.renderer.destroy()
    }
  })

  test("flags failing tools in the collapsed header and reveals them when expanded", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1 } = twoRunningTools()
      const t2: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m2.id,
        type: "tool",
        callID: "call",
        tool: "bash",
        state: { status: "error", input: { command: "bun test" }, error: "command not found", time: { start: 1100, end: 1500 } },
      }
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls") && frame.includes("1 failed"))

      // Complete the remaining tool; the failure stays visible in the summary.
      reseedParts(sync, { [m1.id]: [completed(t1, 1000, 1400)] })
      await app.waitForFrame((frame: string) => frame.includes("Worked for") && frame.includes("1 failed"))

      // Expand the group, then the failing row, to reach the error detail.
      const row = rowOf(frameOf(app), "1 failed")
      await app.mockMouse.click(5, row)
      await app.waitForFrame((frame: string) => frame.includes("bun test"))
      await app.mockMouse.click(5, rowOf(frameOf(app), "bun test"))
      await app.waitForFrame((frame: string) => frame.includes("command not found"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl+o expands every group and collapses them again", async () => {
    const { app, sync } = await mountActivity()
    try {
      const { m1, m2, t1, t2 } = twoRunningTools()
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Working... 2 tool calls"))
      expect(frameOf(app)).not.toContain("Read src/a.ts")

      app.mockInput.pressKey("o", { ctrl: true })
      await app.waitForFrame((frame: string) => frame.includes("Read src/a.ts"))
      expect(frameOf(app)).toContain("▾")

      app.mockInput.pressKey("o", { ctrl: true })
      await app.waitForFrame((frame: string) => !frame.includes("Read src/a.ts"))
      expect(frameOf(app)).toContain("▸")
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl+o clears individually expanded groups", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "In between.")
      const t3 = running(m3.id, "read", { filePath: "src/c.ts" }, 1200)
      const t4 = running(m3.id, "read", { filePath: "src/d.ts" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note] },
      ])
      reseedParts(sync, { [m3.id]: [note, t3, t4] })
      await app.waitForFrame(
        (frame: string) => frame.includes("In between.") && frame.match(/Working... 2 tool calls/g)?.length === 2,
      )

      // Expand only the first group, individually.
      const firstRow = rowOf(frameOf(app), "Working... 2 tool calls")
      await app.mockMouse.click(5, firstRow)
      await app.waitForFrame((frame: string) => frame.includes("Read src/a.ts"))
      expect(frameOf(app)).not.toContain("Read src/c.ts")

      // Toggle the global state on...
      app.mockInput.pressKey("o", { ctrl: true })
      await app.waitForFrame((frame: string) => frame.includes("Read src/c.ts"))

      // ...and off again: everything must end up collapsed, including the
      // group that was expanded individually.
      app.mockInput.pressKey("o", { ctrl: true })
      await app.waitForFrame(
        (frame: string) => !frame.includes("Read src/a.ts") && !frame.includes("Read src/c.ts"),
      )
      const frame = frameOf(app)
      expect(frame).toContain("▸")
      expect(frame).not.toContain("▾")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps groups separated by assistant text independent", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "read", { filePath: "src/b.ts" }, 1100)
      // Created before t3/t4 so its part id sorts ahead of them in the store.
      const note = textPart(m3.id, "Interim note.")
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      const t4 = running(m3.id, "bash", { command: "pwd" }, 1300)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [t2] },
        { message: m3, parts: [note] },
      ])
      reseedParts(sync, { [m3.id]: [note, t3, t4] })
      await app.waitForFrame(
        (frame: string) => frame.includes("Interim note.") && frame.match(/Working... 2 tool calls/g)?.length === 2,
      )

      const frame = frameOf(app)
      expect(frame).toContain("Interim note.")
      // Both groups are collapsed: no command details leak out.
      expect(frame).not.toContain("pwd")

      // Expand only the first group.
      const firstRow = rowOf(frame, "Working... 2 tool calls")
      await app.mockMouse.click(5, firstRow)
      await app.waitForFrame((frame: string) => frame.includes("Read src/a.ts"))
      const expanded = frameOf(app)
      expect(expanded).toContain("Read src/a.ts")
      expect(expanded).toContain("Read src/b.ts")
      expect(expanded).not.toContain("pwd")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps one Working group across per-turn reasoning interleaved with tool calls", async () => {
    const { app, sync } = await mountActivity({ height: 30 })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      seed(sync, [
        { message: m1, parts: [t1] },
        { message: m2, parts: [reasoningPart(m2.id, "thinking"), t2] },
        { message: m3, parts: [reasoningPart(m3.id, "thinking again"), t3] },
      ])
      const frame = () => frameOf(app)
      await app.waitForFrame((f) => f.match(/Working... 3 tool calls/g)?.length === 1)
      expect(frame()).toContain("Working... 3 tool calls")
      expect(frame()).not.toContain("Working... 2 tool calls")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a lone tool call natively without a group header", async () => {
    const { app, sync } = await mountActivity()
    try {
      const m1 = assistant("m1", at(1))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      seed(sync, [{ message: m1, parts: [textPart(m1.id, "One file."), t1] }])
      await app.waitForFrame((frame: string) => frame.includes("Read src/a.ts"))
      const frame = frameOf(app)
      expect(frame).not.toContain("Working...")
      expect(frame).not.toContain("Worked for")
    } finally {
      app.renderer.destroy()
    }
  })

  test("expanding and collapsing keeps the scroll position", async () => {
    const { app, sync, scroll } = await mountActivity({ height: 6, width: 60 })
    try {
      // A run of six tool calls (one group) sandwiched between filler text,
      // so the group header is mid-transcript and the expanded rows appear in
      // the viewport instead of below it.
      const top = assistant("m0", at(0))
      const topText = "filler a1\nfiller a2\nfiller a3\nfiller a4"
      const rows: { message: Message; parts: Part[] }[] = [
        { message: top, parts: [textPart(top.id, topText)] },
      ]
      for (let index = 0; index < 6; index++) {
        const message = assistant(`m${index + 1}`, at(index + 1))
        const part = running(message.id, "read", { filePath: `src/file${index}.ts` }, 1000 + index * 100)
        rows.push({ message, parts: [part] })
      }
      const bottom = assistant("m7", at(7))
      const bottomText = Array.from({ length: 12 }, (_, index) => `filler line ${index + 1}`).join("\n")
      rows.push({ message: bottom, parts: [textPart(bottom.id, bottomText)] })
      seed(sync, rows)

      const box = scroll()
      if (!box) throw new Error("scrollbox not found")
      // Wait until the content overflows the viewport, then bring the
      // (collapsed) group header into view without being at the top.
      let pass = 0
      while ((box.scrollHeight ?? 0) <= box.height && pass++ < 100) await app.renderOnce()
      if ((box.scrollHeight ?? 0) <= box.height) throw new Error("content did not overflow the viewport")
      box.scrollTo(3)
      await app.renderOnce()
      await app.waitForFrame((frame: string) => frame.includes("Working... 6 tool calls"))
      const before = box.scrollTop
      if (before === 0) throw new Error("expected a non-zero scroll offset")

      const row = rowOf(frameOf(app), "Working... 6 tool calls")
      await app.mockMouse.click(5, row)
      await app.waitForFrame((frame: string) => frame.includes("Read src/file0.ts"))
      expect(box.scrollTop).toBe(before)

      await app.mockMouse.click(5, rowOf(frameOf(app), "Working... 6 tool calls"))
      await app.waitForFrame((frame: string) => !frame.includes("Read src/file0.ts"))
      expect(box.scrollTop).toBe(before)
    } finally {
      app.renderer.destroy()
    }
  })

  test("ActivityGroup renders its header state directly", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const group = findGroup(storeSync)
        if (!group) return <text>waiting</text>
        return <ActivityGroup groupID={group} />
      },
    })
    try {
      const m1 = assistant("m1", at(1))
      const t1: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m1.id,
        type: "tool",
        callID: "call",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/a.ts" }, output: "", title: "", metadata: {}, time: { start: 1000, end: 1420 } },
      }
      const t2: ToolPart = {
        id: nextPartID(),
        sessionID: SESSION,
        messageID: m1.id,
        type: "tool",
        callID: "call",
        tool: "grep",
        state: { status: "completed", input: { pattern: "todo" }, output: "", title: "", metadata: {}, time: { start: 1200, end: 2420 } },
      }
      seed(sync, [{ message: m1, parts: [t1, t2] }])
      await app.waitForFrame((frame: string) => frame.includes("Worked for 1.4s · 2 tool calls"))
      const frame = frameOf(app)
      expect(frame).toContain("Worked for 1.4s · 2 tool calls")
      expect(frame).toContain("▸")
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not render a second model footer for a finish-only turn", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const messages = storeSync.data.message[SESSION] ?? []
        const lastId = messages[messages.length - 1]?.id
        return (
          <For each={messages}>
            {(message) => {
              const isLast = message.id === lastId
              return (
                <Switch>
                  <Match when={message.role === "user"}>
                    <text>
                      {(storeSync.data.part[message.id] ?? [])
                        .filter((part): part is TextPart => part.type === "text")
                        .map((part) => part.text)
                        .join(" ")}
                    </text>
                  </Match>
                  <Match when={true}>
                    <AssistantMessageRow
                      message={message as AssistantMessage}
                      parts={storeSync.data.part[message.id] ?? []}
                      last={isLast}
                    />
                  </Match>
                </Switch>
              )
            }}
          </For>
        )
      },
    })
    try {
      const mainMsg = assistant("m_main", at(1))
      const finishOnlyMsg = assistant("m_finish", at(2))
      const mainText = textPart(mainMsg.id, "I will investigate this.")
      const finishTool = running(finishOnlyMsg.id, "finish", { reason: "complete" }, 1100)
      const userMsg = {
        id: "msg_user",
        sessionID: SESSION,
        role: "user" as const,
        time: { created: at(0) },
        parentID: "",
        model: { providerID: "test", modelID: "model" },
        modelID: "model",
        providerID: "test",
        mode: "work",
        agent: "work",
        path: { cwd: "/tmp", root: "/tmp" },
      }
      // main turn gets finish:"stop" so it is the substantive turn with a footer
      seed(sync, [
        { message: userMsg, parts: [] },
        { message: { ...mainMsg, finish: "stop" }, parts: [mainText] },
        { message: finishOnlyMsg, parts: [finishTool] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Work · model"))
      const frame = frameOf(app)
      // Exactly one footer marker: the substantive turn's footer.
      // The finish-only turn must not produce a second standalone footer.
      const footerMarkers = (frame.match(/▣/g) || []).length
      expect(footerMarkers).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("genuine separate model turns each render their own footer", async () => {
    const { app, sync } = await mountActivity({
      render: (storeSync) => {
        const messages = storeSync.data.message[SESSION] ?? []
        const lastId = messages[messages.length - 1]?.id
        return (
          <For each={messages}>
            {(message) => {
              const isLast = message.id === lastId
              return (
                <Switch>
                  <Match when={message.role === "user"}>
                    <text>
                      {(storeSync.data.part[message.id] ?? [])
                        .filter((part): part is TextPart => part.type === "text")
                        .map((part) => part.text)
                        .join(" ")}
                    </text>
                  </Match>
                  <Match when={true}>
                    <AssistantMessageRow
                      message={message as AssistantMessage}
                      parts={storeSync.data.part[message.id] ?? []}
                      last={isLast}
                    />
                  </Match>
                </Switch>
              )
            }}
          </For>
        )
      },
    })
    try {
      const m1 = assistant("m1", at(1))
      const m2 = assistant("m2", at(2))
      const m3 = assistant("m3", at(3))
      const t1 = running(m1.id, "read", { filePath: "src/a.ts" }, 1000)
      const t2 = running(m2.id, "grep", { pattern: "todo" }, 1100)
      const t3 = running(m3.id, "bash", { command: "ls" }, 1200)
      const userMsg = {
        id: "msg_user",
        sessionID: SESSION,
        role: "user" as const,
        time: { created: at(0) },
        parentID: "",
        model: { providerID: "test", modelID: "model" },
        modelID: "model",
        providerID: "test",
        mode: "work",
        agent: "work",
        path: { cwd: "/tmp", root: "/tmp" },
      }
      seed(sync, [
        { message: userMsg, parts: [] },
        { message: { ...m1, finish: "stop" }, parts: [textPart(m1.id, "Step one."), t1] },
        { message: { ...m2, finish: "stop" }, parts: [textPart(m2.id, "Step two."), t2] },
        { message: { ...m3, finish: "stop" }, parts: [textPart(m3.id, "Done."), t3] },
      ])
      await app.waitForFrame((frame: string) => frame.includes("Work · model"))
      const frame = frameOf(app)
      // Three substantive turns, each with content, each gets its own footer
      const footerMarkers = (frame.match(/▣/g) || []).length
      expect(footerMarkers).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })
})
