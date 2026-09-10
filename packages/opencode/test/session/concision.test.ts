import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"
import { Concision } from "@/session/concision"
import { LLMRequestPrep } from "@/session/llm/request"
import { SystemPrompt } from "@/session/system"
import type { Provider } from "@/provider/provider"

const MARKER = "Output concision policy"

// A verbose preamble of the kind the issue calls out: filler lead-in,
// restated request, narrated tool plan, and a recap — 4 paragraphs,
// well past the strict cap.
const PREAMBLE = [
  "Sure! Great question! Let me restate what you asked so we are on the same page: you want me to look at the failing test, figure out why it broke, and fix it without changing any unrelated behavior anywhere else in the codebase.",
  "I will now start by reading the test file to understand the failing assertion, then I will check the second part of the implementation to see how the helper is wired up, and after that I will run the suite to confirm the failure reproduces on this machine.",
  "Let me check the second part of the flow first. I will now read the next file in the chain and trace the value through every layer so nothing is missed, because a careful and thorough investigation up front saves time later.",
  "To recap: restate the task, narrate the plan, read the files, run the tests, and then summarize everything at the end in a long closing paragraph that repeats the whole story once more for good measure.",
].join("\n\n")

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

const prepare = (input?: { concision?: Concision.Resolved }) =>
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
    concision: input?.concision,
  })

const history = (
  messages: Array<{ role: string; text?: string; synthetic?: boolean }>,
): Concision.HistoryMessage[] =>
  messages.map((m) => ({
    info: { role: m.role },
    parts:
      m.text === undefined
        ? []
        : [{ type: "text", text: m.text, synthetic: m.synthetic }],
  }))

describe("concision config", () => {
  test("config accepts concision and defaults to strict", () => {
    expect(ConfigParse.schema(ConfigV1.Info, {}, "test").concision).toBeUndefined()
    expect(ConfigParse.schema(ConfigV1.Info, { concision: "strict" }, "test").concision).toBe("strict")
    expect(ConfigParse.schema(ConfigV1.Info, { concision: "normal" }, "test").concision).toBe("normal")
    expect(ConfigParse.schema(ConfigV1.Info, { concision: "off" }, "test").concision).toBe("off")
    expect(Concision.normalizeMode(undefined)).toBe("strict")
    expect(Concision.normalizeMode("bogus")).toBe("strict")
  })

  test("resolve precedence: override > session > config > default", () => {
    expect(Concision.resolve({}).mode).toBe("strict")
    expect(Concision.resolve({ config: "normal" }).mode).toBe("normal")
    expect(Concision.resolve({ config: "normal", session: "off" }).mode).toBe("off")
    expect(Concision.resolve({ config: "off", session: "bogus" }).mode).toBe("off")
    expect(Concision.resolve({ config: "strict", override: "long" }).lifted).toBe(true)
    expect(Concision.resolve({ config: "off" }).lifted).toBe(true)
    expect(Concision.resolve({ config: "strict", override: "brief" }).caps).toEqual({
      maxWords: Concision.BRIEF_MAX_WORDS,
      maxParagraphs: Concision.BRIEF_MAX_PARAGRAPHS,
    })
  })
})

describe("concision turn overrides", () => {
  test("parses [long] and [brief], last token wins", () => {
    expect(Concision.parseTurnOverride("fix the bug")).toBeUndefined()
    expect(Concision.parseTurnOverride("[long] explain everything")).toBe("long")
    expect(Concision.parseTurnOverride("be quick [brief]")).toBe("brief")
    expect(Concision.parseTurnOverride("[LONG] details please")).toBe("long")
    expect(Concision.parseTurnOverride("[brief] actually [long] never mind")).toBe("long")
    expect(Concision.parseTurnOverride("[long] actually [brief] keep it tight")).toBe("brief")
  })

  test("only the latest real user message carries the override", () => {
    expect(
      Concision.turnOverrideFromHistory(history([{ role: "user", text: "[long] explain" }])),
    ).toBe("long")
    // Synthetic finish nudges after the user message must not swallow it.
    expect(
      Concision.turnOverrideFromHistory(
        history([
          { role: "user", text: "[long] explain" },
          { role: "assistant", text: "working" },
          { role: "user", text: "You must call finish.", synthetic: true },
        ]),
      ),
    ).toBe("long")
    // A newer task without a token must not inherit an older [long].
    expect(
      Concision.turnOverrideFromHistory(
        history([
          { role: "user", text: "[long] explain" },
          { role: "assistant", text: "done" },
          { role: "user", text: "now fix this" },
        ]),
      ),
    ).toBeUndefined()
  })
})

describe("concision enforcement", () => {
  test("verbose preamble is cut to ≤80 words and ≤2 paragraphs", () => {
    expect(Concision.splitParagraphs(PREAMBLE).length).toBeGreaterThanOrEqual(3)
    expect(Concision.countWords(PREAMBLE)).toBeGreaterThan(80)
    const result = Concision.enforce(PREAMBLE, Concision.resolve({}))
    expect(result.truncated).toBe(true)
    expect(Concision.countWords(result.text)).toBeLessThanOrEqual(80)
    expect(Concision.splitParagraphs(result.text).length).toBeLessThanOrEqual(2)
    expect(result.text).toContain("… [+")
    expect(result.omittedWords).toBeGreaterThan(0)
    // Filler lead-in is stripped, not kept: the first sentence carries payload.
    expect(result.text.startsWith("Sure!")).toBe(false)
  })

  test("short replies pass through untouched", () => {
    const short = "Fixed the off-by-one in the retry loop. Tests pass."
    const result = Concision.enforce(short, Concision.resolve({}))
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(short)
  })

  test("filler lead-ins are stripped even within budget", () => {
    expect(Concision.stripFiller("Sure! Fixed the bug.")).toBe("Fixed the bug.")
    expect(Concision.stripFiller("Of course! Here is the diff.")).toBe("Here is the diff.")
    expect(Concision.stripFiller("Surely this edge case matters.")).toBe("Surely this edge case matters.")
    expect(Concision.stripFiller("Fixed the bug.")).toBe("Fixed the bug.")
  })

  test("fenced code is a deliverable and is never truncated", () => {
    const code = ["Here is the patch:", "", "```ts", "const x = 1", "```"].join("\n") + `\n\n${"word ".repeat(200)}`
    const result = Concision.enforce(code, Concision.resolve({}))
    expect(result.truncated).toBe(false)
    expect(result.text).toContain("const x = 1")
  })

  test("[brief] tightens the cap to 40 words / 1 paragraph", () => {
    const twoParas = `${"word ".repeat(30).trim()}\n\n${"word ".repeat(30).trim()}`
    const result = Concision.enforce(twoParas, Concision.resolve({ override: "brief" }))
    expect(result.truncated).toBe(true)
    expect(Concision.countWords(result.text)).toBeLessThanOrEqual(Concision.BRIEF_MAX_WORDS)
    expect(Concision.splitParagraphs(result.text).length).toBeLessThanOrEqual(1)
  })

  test("[long] lifts the cap entirely", () => {
    const result = Concision.enforce(PREAMBLE, Concision.resolve({ override: "long" }))
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(PREAMBLE)
  })
})

describe("concision system prompt", () => {
  test("fragment carries the active cap and is empty when lifted", () => {
    const strict = SystemPrompt.concision(Concision.resolve({}))
    expect(strict.join("\n")).toContain(MARKER)
    expect(strict.join("\n")).toContain("80 words")
    expect(SystemPrompt.concision(Concision.resolve({ override: "long" }))).toEqual([])
    expect(SystemPrompt.concision(Concision.resolve({ config: "off" }))).toEqual([])
    expect(SystemPrompt.concision(undefined)).toEqual([])
  })

  test("prepare injects the policy only when resolved and capped", async () => {
    const unset = await Effect.runPromise(prepare())
    expect(unset.system.join("\n")).not.toContain(MARKER)
    const strict = await Effect.runPromise(prepare({ concision: Concision.resolve({}) }))
    expect(strict.system.join("\n")).toContain(MARKER)
    expect(strict.system.join("\n")).toContain("80")
    const lifted = await Effect.runPromise(prepare({ concision: Concision.resolve({ override: "long" }) }))
    expect(lifted.system.join("\n")).not.toContain(MARKER)
  })
})
