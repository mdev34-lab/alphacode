/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import plugin from "../../src/feature-plugins/sidebar/context"

const message = (input: number): AssistantMessage => ({
  id: "m",
  sessionID: "s",
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "u",
  modelID: "model",
  providerID: "test",
  mode: "work",
  agent: "work",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
})
for (const item of [
  { name: "empty", messages: [], model: true, detail: "usage unknown", bar: "░".repeat(20) },
  { name: "missing-model", messages: [message(1199)], model: false, detail: "usage unknown", bar: "░".repeat(20) },
  {
    name: "measured-zero-percent",
    messages: [message(0)],
    model: true,
    detail: "1 tokens · 0% used",
    bar: "░".repeat(20),
  },
  {
    name: "input-only",
    messages: [{ ...message(30000), tokens: { input: 30000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
    model: true,
    detail: "30,000 tokens · 15% used",
    bar: "█".repeat(3) + "░".repeat(17),
  },
  {
    name: "partial",
    messages: [message(29999)],
    model: true,
    detail: "30,000 tokens · 15% used",
    bar: "█".repeat(3) + "░".repeat(17),
  },
  {
    name: "near-limit",
    messages: [message(183999)],
    model: true,
    detail: "184,000 tokens · 92% used",
    bar: "█".repeat(18) + "░".repeat(2),
  },
])
  test(`render slot ${item.name}`, async () => {
    let view!: () => JSX.Element
    const api = {
      theme: { current: { text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#aaaaaa") } },
      state: {
        session: { messages: () => item.messages, get: () => ({ cost: 1.25 }) },
        provider: item.model ? [{ id: "test", models: { model: { limit: { context: 200000 } } } }] : [],
      },
      slots: {
        register: (definition: {
          slots: { sidebar_content: (ctx: unknown, props: { session_id: string }) => JSX.Element }
        }) => {
          view = () => definition.slots.sidebar_content({}, { session_id: "s" })
        },
      },
    } as unknown as TuiPluginApi
    await plugin.tui(api, undefined, {
      id: plugin.id,
      source: "internal",
      spec: plugin.id,
      target: plugin.id,
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 1,
      fingerprint: "test",
      state: "first",
    })
    const app = await testRender(() => view(), { width: 40, height: 6 })
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Context")
      expect(frame).toContain(item.bar)
      expect(frame).toContain(item.detail)
      expect(frame).toContain("$1.25 spent")
      expect(frame).not.toContain("▨")
    } finally {
      app.renderer.destroy()
    }
  })
