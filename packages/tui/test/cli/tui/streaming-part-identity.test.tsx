/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { For, onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import type { GlobalEvent, Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createEventSource, createFetch } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ExitProvider } from "../../../src/context/exit"
import { ProjectProvider } from "../../../src/context/project"
import { PermissionProvider } from "../../../src/context/permission"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { RouteProvider } from "../../../src/context/route"
import { TuiConfigProvider } from "../../../src/config"

let mountCount = 0

function textPart(partID: string, messageID: string, sessionID: string, text = ""): TextPart {
  return { id: partID, sessionID, messageID, type: "text", text }
}

function reasoningPart(partID: string, messageID: string, sessionID: string, text = ""): ReasoningPart {
  return { id: partID, sessionID, messageID, type: "reasoning", text, time: { start: 1 } }
}

function assistantMessage(messageID: string, sessionID: string) {
  const now = 1_700_000_000_000
  return {
    id: messageID,
    sessionID,
    role: "assistant" as const,
    time: { created: now },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "work",
    agent: "work",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp", project: "proj_test", payload }
}

function deltaEvent(sessionID: string, messageID: string, partID: string, delta: string, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_delta_${id}`,
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field: "text", delta },
  })
}

function updatedEvent(sessionID: string, messageID: string, part: Part, id: number): GlobalEvent {
  return globalEvent({
    id: `evt_updated_${id}`,
    type: "message.part.updated",
    properties: { sessionID, time: id, part },
  })
}

async function waitUntil(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Sync = ReturnType<typeof useSync>

function PartRow(props: { part: Part }) {
  onMount(() => {
    mountCount++
  })
  return <text>{(props.part as TextPart | ReasoningPart).text}</text>
}

function StreamProbe(props: { messageID: string }) {
  const sync = useSync()
  return <For each={sync.data.part[props.messageID] ?? []}>{(part) => <PartRow part={part} />}</For>
}

let setup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined

afterEach(async () => {
  await setup?.dispose()
  setup = undefined
  mountCount = 0
})

async function mount(sessionID: string, messageID: string) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(undefined, events)

  let sync!: Sync
  function Harness() {
    const store = useSync()
    sync = store
    return <StreamProbe messageID={messageID} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory="/tmp" paths={{ home: "/tmp", state, worktree: "/tmp" }}>
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <KVProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID }}>
                <TuiConfigProvider config={createTuiResolvedConfig()}>
                  <SDKProvider url="http://test" directory="/tmp" fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <SyncProvider>
                          <Harness />
                        </SyncProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  setup = {
    app,
    dispose: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
  await waitUntil(() => sync !== undefined)
  await app.renderOnce()
  return { app, events, sync }
}

async function mountSingle(part: Part) {
  const sessionID = part.sessionID
  const messageID = part.messageID
  const { app, events, sync } = await mount(sessionID, messageID)
  sync.set("message", sessionID, [assistantMessage(messageID, sessionID)])
  sync.set("part", messageID, [part])
  await app.renderOnce()
  expect(mountCount).toBe(1)
  return { app, events, sync, sessionID, messageID }
}

function textOf(sync: Sync, messageID: string, partID: string): string {
  const part = (sync.data.part[messageID] ?? []).find((item) => item.id === partID)
  return part ? (part as TextPart | ReasoningPart).text : ""
}

describe("streaming part identity", () => {
  test("deltas and a stale empty snapshot update text without remounting the keyed row", async () => {
    const sessionID = "ses_stream"
    const messageID = "msg_stream"
    const partID = "prt_stream"
    const { app, events, sync } = await mountSingle(textPart(partID, messageID, sessionID))

    try {
      const deltas = ["Hello ", "streaming ", "world", "!"]
      deltas.forEach((delta, index) => {
        events.emit(deltaEvent(sessionID, messageID, partID, delta, index))
        // A durable "started" row (empty text) can be replayed mid-stream.
        if (index === 1) events.emit(updatedEvent(sessionID, messageID, textPart(partID, messageID, sessionID), index))
      })

      await waitUntil(() => textOf(sync, messageID, partID) === "Hello streaming world!")
      await app.renderOnce()

      expect(mountCount).toBe(1)
      expect(app.captureCharFrame().split("\n").join("")).toContain("Hello streaming world!")
    } finally {
      app.renderer.destroy()
    }
  })

  test("an authoritative snapshot equal to the streamed text is adopted without remounting", async () => {
    const sessionID = "ses_snap"
    const messageID = "msg_snap"
    const partID = "prt_snap"
    const { app, events, sync } = await mountSingle(textPart(partID, messageID, sessionID))

    try {
      events.emit(deltaEvent(sessionID, messageID, partID, "Hello ", 0))
      events.emit(deltaEvent(sessionID, messageID, partID, "world", 1))
      // The durable row persisted the full text after the deltas streamed.
      events.emit(updatedEvent(sessionID, messageID, textPart(partID, messageID, sessionID, "Hello world"), 2))

      await waitUntil(() => textOf(sync, messageID, partID) === "Hello world")
      await app.renderOnce()

      expect(mountCount).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a partially persisted snapshot never truncates the streamed text", async () => {
    const sessionID = "ses_partial"
    const messageID = "msg_partial"
    const partID = "prt_partial"
    const { app, events, sync } = await mountSingle(textPart(partID, messageID, sessionID))

    try {
      events.emit(deltaEvent(sessionID, messageID, partID, "Hello ", 0))
      events.emit(deltaEvent(sessionID, messageID, partID, "world", 1))
      // The durable row persisted only the prefix ("Hello ") mid-stream.
      events.emit(updatedEvent(sessionID, messageID, textPart(partID, messageID, sessionID, "Hello "), 2))

      await waitUntil(() => textOf(sync, messageID, partID) === "Hello world")
      await app.renderOnce()

      expect(mountCount).toBe(1)
      expect(app.captureCharFrame().split("\n").join("")).toContain("Hello world")
    } finally {
      app.renderer.destroy()
    }
  })

  test("reasoning parts stream without remounting", async () => {
    const sessionID = "ses_reason"
    const messageID = "msg_reason"
    const partID = "prt_reason"
    const { app, events, sync } = await mountSingle(reasoningPart(partID, messageID, sessionID))

    try {
      events.emit(deltaEvent(sessionID, messageID, partID, "think", 0))
      events.emit(deltaEvent(sessionID, messageID, partID, "ing", 1))
      // Stale empty durable row mid-stream.
      events.emit(updatedEvent(sessionID, messageID, reasoningPart(partID, messageID, sessionID), 2))

      await waitUntil(() => textOf(sync, messageID, partID) === "thinking")
      await app.renderOnce()

      expect(mountCount).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a new part arriving during streaming keeps earlier parts mounted", async () => {
    const sessionID = "ses_multi"
    const messageID = "msg_multi"
    const partA = "prt_a"
    const partB = "prt_b"
    const { app, events, sync } = await mount(sessionID, messageID)
    sync.set("message", sessionID, [assistantMessage(messageID, sessionID)])
    sync.set("part", messageID, [textPart(partA, messageID, sessionID)])
    await app.renderOnce()
    expect(mountCount).toBe(1)

    try {
      events.emit(deltaEvent(sessionID, messageID, partA, "alpha ", 0))
      // A second part is created by the runner while the first is streaming.
      events.emit(updatedEvent(sessionID, messageID, textPart(partB, messageID, sessionID), 1))
      events.emit(deltaEvent(sessionID, messageID, partB, "beta", 2))
      events.emit(deltaEvent(sessionID, messageID, partA, "one", 3))

      await waitUntil(() => textOf(sync, messageID, partA) === "alpha one" && textOf(sync, messageID, partB) === "beta")
      await app.renderOnce()

      // Exactly one row per part, and the first never remounted.
      expect(mountCount).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})
