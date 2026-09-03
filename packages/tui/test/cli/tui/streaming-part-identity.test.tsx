/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { For, onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import type { GlobalEvent, TextPart } from "@opencode-ai/sdk/v2"
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

const SESSION = "ses_stream"
const MESSAGE = "msg_stream"
const PART = "prt_stream"

let mountCount = 0

function textPart(): TextPart {
  return { id: PART, sessionID: SESSION, messageID: MESSAGE, type: "text", text: "" }
}

function assistantMessage() {
  const now = 1_700_000_000_000
  return {
    id: MESSAGE,
    sessionID: SESSION,
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

function deltaEvent(delta: string, id: number): GlobalEvent {
  return {
    directory: "/tmp",
    project: "proj_test",
    payload: {
      id: `evt_delta_${id}`,
      type: "message.part.delta",
      properties: {
        sessionID: SESSION,
        messageID: MESSAGE,
        partID: PART,
        field: "text",
        delta,
      },
    },
  }
}

// A durable snapshot can arrive mid-stream while its persisted text is still
// empty (the row is written before the deltas are streamed). The reducer must
// keep the already-streamed text without replacing the part object.
function staleSnapshotEvent(id: number): GlobalEvent {
  return {
    directory: "/tmp",
    project: "proj_test",
    payload: {
      id: `evt_updated_${id}`,
      type: "message.part.updated",
      properties: {
        sessionID: SESSION,
        time: 0,
        part: { id: PART, sessionID: SESSION, messageID: MESSAGE, type: "text", text: "" },
      },
    },
  }
}

async function waitUntil(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Sync = ReturnType<typeof useSync>

function PartRow(props: { part: TextPart }) {
  onMount(() => {
    mountCount++
  })
  return <text>{props.part.text}</text>
}

function StreamProbe() {
  const sync = useSync()
  return <For each={sync.data.part[MESSAGE] ?? []}>{(part) => <PartRow part={part as TextPart} />}</For>
}

let setup: { app: Awaited<ReturnType<typeof testRender>>; dispose: () => Promise<void> } | undefined

afterEach(async () => {
  await setup?.dispose()
  setup = undefined
  mountCount = 0
})

async function mount() {
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
    return <StreamProbe />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory="/tmp" paths={{ home: "/tmp", state, worktree: "/tmp" }}>
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <KVProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID: SESSION }}>
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

describe("streaming part identity", () => {
  test("deltas update the text without remounting the keyed part row", async () => {
    const { app, events, sync } = await mount()
    try {
      sync.set("message", SESSION, [assistantMessage()])
      sync.set("part", MESSAGE, [textPart()])
      await app.renderOnce()
      expect(mountCount).toBe(1)

      const deltas = ["Hello ", "streaming ", "world", "!"]
      deltas.forEach((delta, index) => {
        events.emit(deltaEvent(delta, index))
        if (index === 1) events.emit(staleSnapshotEvent(index))
      })

      await waitUntil(() => (sync.data.part[MESSAGE]?.[0] as TextPart).text === "Hello streaming world!")
      await app.renderOnce()

      // The part row is keyed by object identity in the transcript (Solid's
      // <For>). A reducer that substitutes a new part object for each delta
      // unmounts and remounts the streaming row on every token — that is what
      // shows up as aggressive redraw/flicker. Identity must be stable.
      expect(mountCount).toBe(1)
      expect(app.captureCharFrame().split("\n").join("")).toContain("Hello streaming world!")
    } finally {
      app.renderer.destroy()
    }
  })
})
