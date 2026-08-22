import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"
import { LLMRequestPrep } from "@/session/llm/request"
import { SystemPrompt } from "@/session/system"
import DEFAULT_PROMPT from "../../src/session/prompt/default.txt"
import TRINITY_PROMPT from "../../src/session/prompt/trinity.txt"
import type { Provider } from "@/provider/provider"

const MARKER = "Do not apply this style to deliverables"

const model = {
  id: "test/test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://api.test.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
} as Provider.Model

const prepare = (input?: { steLite?: boolean; prompt?: string }) =>
  LLMRequestPrep.prepare({
    user: {
      id: "msg_user-test",
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "work",
      model: { providerID: "test", modelID: "test-model" },
    } as any,
    sessionID: "ses_test",
    model,
    agent: {
      name: "work",
      mode: "primary",
      options: {},
      permission: [],
      prompt: input?.prompt,
    } as any,
    system: [],
    messages: [{ role: "user", content: "Hello" }],
    tools: {
      lookup: {
        description: "Look up a value",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
      },
    },
    provider: { id: "test", options: {} } as any,
    auth: undefined,
    plugin: {
      trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    } as any,
    flags: { outputTokenMax: 32_000, client: "test" } as any,
    isWorkflow: false,
    steLite: input?.steLite,
  })

describe("ste-lite", () => {
  test("config accepts ste_lite", () => {
    expect(ConfigParse.schema(ConfigV1.Info, {}, "test").ste_lite).toBeUndefined()
    expect(ConfigParse.schema(ConfigV1.Info, { ste_lite: true }, "test").ste_lite).toBe(true)
    expect(ConfigParse.schema(ConfigV1.Info, { ste_lite: false }, "test").ste_lite).toBe(false)
  })

  test("style fragment is on by default and off when disabled", () => {
    expect(SystemPrompt.style().join("\n")).toContain(MARKER)
    expect(SystemPrompt.style(true).join("\n")).toBe(SystemPrompt.STE_LITE)
    expect(SystemPrompt.style(false)).toEqual([])
  })

  test("provider prompts no longer use the four-line quota", () => {
    expect(DEFAULT_PROMPT).not.toContain("fewer than 4 lines")
    expect(TRINITY_PROMPT).not.toContain("fewer than 4 lines")
  })

  test("prepare injects STE-lite by default, including custom agent prompts", async () => {
    const unset = await Effect.runPromise(prepare())
    const custom = await Effect.runPromise(prepare({ prompt: "You are compaction." }))
    expect(unset.system.join("\n")).toContain(MARKER)
    expect(custom.system.join("\n")).toContain(MARKER)
    expect(custom.system.join("\n")).toContain("You are compaction.")
  })

  test("prepare omits STE-lite when disabled", async () => {
    const result = await Effect.runPromise(prepare({ steLite: false, prompt: "You are compaction." }))
    expect(result.system.join("\n")).not.toContain(MARKER)
    expect(result.system.join("\n")).toContain("You are compaction.")
  })
})
