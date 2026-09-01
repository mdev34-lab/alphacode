import { describe, expect, test } from "bun:test"
import { LLM, Model, SystemPart, type LLMRequest } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as Gemini from "@opencode-ai/llm/protocols/gemini"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ContextDeduplicate } from "@opencode-ai/core/context/deduplicate"
import { ContextInvariants } from "@opencode-ai/core/context/invariants"
import { ContextManager } from "@opencode-ai/core/context/manager"
import { ContextPlaceholder } from "@opencode-ai/core/context/placeholders"
import { ContextProtection } from "@opencode-ai/core/context/protection"
import { ContextPurgeErrors } from "@opencode-ai/core/context/purge-errors"
import { ContextSettings } from "@opencode-ai/core/context/settings"
import type { ContextTypes } from "@opencode-ai/core/context/types"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { DateTime, Effect } from "effect"

const sessionID = "ses_provider_shape" as SessionSchema.ID
const created = DateTime.makeUnsafe(0)
const settings = ContextSettings.settings([])
const limits = { context: 200_000, output: 8_000 }

const user = (id: string, text: string): SessionMessage.Message => ({
  id: SessionMessage.ID.make(id),
  type: "user",
  text,
  time: { created },
})

const assistant = (id: string, content: SessionMessage.Assistant["content"]): SessionMessage.Message => ({
  id: SessionMessage.ID.make(id),
  type: "assistant",
  agent: "build",
  model: { providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("fake-model") },
  content,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, completed: created },
})

const read = (id: string, file: string): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "read",
  time: { created },
  state: {
    status: "completed",
    input: { filePath: file },
    structured: {},
    content: [{ type: "text", text: `contents of ${file}\n${"export const value = 1\n".repeat(20)}` }],
  },
})

const failed = (id: string): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "bash",
  time: { created },
  state: {
    status: "error",
    input: { command: `echo ${"x".repeat(600)}` },
    structured: {},
    content: [{ type: "text", text: "exit code 1" }],
    error: { type: "unknown", message: "exit code 1" },
  },
})

/** Canonical history covering every transformation the compiler can apply. */
const canonical: SessionMessage.Message[] = [
  user("msg_1", "explore the repository"),
  assistant("msg_2", [{ type: "text", id: "t1", text: "Exploring" }]),
  assistant("msg_3", [read("call_1", "src/index.ts")]),
  assistant("msg_4", [failed("call_2")]),
  assistant("msg_5", [read("call_3", "src/index.ts")]),
  user("msg_6", "now implement the feature"),
  assistant("msg_7", [{ type: "text", id: "t2", text: "Implementing" }]),
]

const block: ContextTypes.CompressionBlock = {
  id: "cmp_1",
  startMessageID: SessionMessage.ID.make("msg_1"),
  endMessageID: SessionMessage.ID.make("msg_2"),
  summary: "The repository was explored and the entry point read.",
  createdAt: 0,
  sourceMessageCount: 2,
  sourceTokenCount: 900,
  summaryTokenCount: 30,
  nested: [],
}

/** Run the real pipeline: placeholders, deduplication, error purging. */
const prepared = () => {
  const protection = ContextProtection.resolve(canonical, { policy: { ...settings.protection, recentTurns: 1 } })
  const placed = ContextPlaceholder.apply(sessionID, canonical, [block], protection.messageIDs)
  const duplicates = ContextDeduplicate.plan(placed.messages, { policy: settings.protection, protection })
  const errors = ContextPurgeErrors.plan(placed.messages, { policy: settings.protection, turns: 0 })
  return ContextPurgeErrors.apply(ContextDeduplicate.apply(placed.messages, duplicates), errors)
}

const request = (
  route: Model["route"],
  messages: readonly SessionMessage.Message[] = prepared(),
): Effect.Effect<LLMRequest> =>
  toLLMMessages(messages, Model.make({ id: "fake-model", provider: "fake", route })).pipe(
    Effect.map((messages) =>
      LLM.request({
        model: Model.make({ id: "fake-model", provider: "fake", route }),
        system: [ContextManager.GUIDANCE, "Baseline system context"].map(SystemPart.make),
        messages,
        tools: [],
      }),
    ),
    Effect.provide(LayerNode.compile(FSUtil.node)),
    Effect.orDie,
  )

const body = <A>(
  route: Model["route"],
  from: (request: LLMRequest) => Effect.Effect<A, unknown>,
  messages?: readonly SessionMessage.Message[],
) => Effect.runPromise(request(route, messages).pipe(Effect.flatMap((input) => from(input).pipe(Effect.orDie))))

const PLACEHOLDER = "<compressed-conversation-section>"
/** The guidance is multi-line, so compare it against JSON-escaped request bodies. */
const GUIDANCE = JSON.stringify(ContextManager.GUIDANCE).slice(1, -1)

describe("provider request invariants", () => {
  test("openai chat keeps one leading system message and pairs every tool result", async () => {
    const openai = await body(OpenAIChat.route.with({ limits }), OpenAIChat.protocol.body.from)

    const systems = openai.messages.filter((message) => message.role === "system")
    expect(systems).toHaveLength(1)
    expect(openai.messages[0]?.role).toBe("system")
    expect(JSON.stringify(systems[0])).toContain(GUIDANCE)

    const calls = openai.messages.flatMap((message) =>
      message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.id) : [],
    )
    const results = openai.messages.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : []))
    expect(results.toSorted()).toEqual(calls.toSorted())

    // The summary is historical user-side content, never a fabricated assistant turn.
    const placeholder = openai.messages.find((message) => JSON.stringify(message.content).includes(PLACEHOLDER))
    expect(placeholder?.role).toBe("user")
    expect(openai.messages.filter((message) => message.role === "assistant")).toHaveLength(4)
    expect(JSON.stringify(openai.messages)).toContain(ContextDeduplicate.MARKER)
    expect(JSON.stringify(openai.messages)).toContain(ContextPurgeErrors.MARKER)
    expect(JSON.stringify(openai.messages)).not.toContain("x".repeat(600))
  })

  test("anthropic messages carry the system prompt out of band", async () => {
    const anthropic = await body(AnthropicMessages.route.with({ limits }), AnthropicMessages.protocol.body.from)

    expect(JSON.stringify(anthropic.system)).toContain(GUIDANCE)
    expect(anthropic.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true)

    const calls = anthropic.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.type === "tool_use" ? [part.id] : [])),
    )
    const results = anthropic.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.type === "tool_result" ? [part.tool_use_id] : [])),
    )
    expect(results.toSorted()).toEqual(calls.toSorted())

    const placeholder = anthropic.messages.find((message) => JSON.stringify(message.content).includes(PLACEHOLDER))
    expect(placeholder?.role).toBe("user")
  })

  test("gemini keeps the system instruction separate from the conversation", async () => {
    const gemini = await body(Gemini.route.with({ limits }), Gemini.protocol.body.from)

    expect(JSON.stringify(gemini.systemInstruction)).toContain(GUIDANCE)
    expect(gemini.contents.every((content) => content.role === "user" || content.role === "model")).toBe(true)

    const calls = gemini.contents.flatMap((content) =>
      content.parts.flatMap((part) => ("functionCall" in part && part.functionCall ? [part.functionCall.name] : [])),
    )
    const results = gemini.contents.flatMap((content) =>
      content.parts.flatMap((part) =>
        "functionResponse" in part && part.functionResponse ? [part.functionResponse.name] : [],
      ),
    )
    expect(results.toSorted()).toEqual(calls.toSorted())

    const placeholder = gemini.contents.find((content) => JSON.stringify(content.parts).includes(PLACEHOLDER))
    expect(placeholder?.role).toBe("user")
  })
})

/**
 * A compressed range that contains a protected tool interaction.
 *
 * Protection wins over compression, so `todowrite` stays verbatim while the rest of its range
 * collapses into the placeholder. That reorders nothing, but it does place a summary immediately
 * before a retained assistant turn, which is exactly the sequence providers are strict about.
 */
const todowrite = (id: string): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "todowrite",
  time: { created },
  state: {
    status: "completed",
    input: { todos: [{ id: "1", content: "migrate the parser", status: "in_progress" }] },
    structured: {},
    content: [{ type: "text", text: "1 todo in progress: migrate the parser" }],
  },
})

const withProtectedRange: SessionMessage.Message[] = [
  user("msg_1", "start the migration"),
  assistant("msg_2", [{ type: "text", id: "t1", text: "Reading the parser" }]),
  assistant("msg_3", [read("call_1", "src/parser.ts")]),
  assistant("msg_4", [todowrite("call_2")]),
  assistant("msg_5", [{ type: "text", id: "t2", text: "Parser migrated" }]),
  user("msg_6", "now update the tests"),
  assistant("msg_7", [{ type: "text", id: "t3", text: "Updating tests" }]),
]

const spanning: ContextTypes.CompressionBlock = {
  id: "cmp_2",
  startMessageID: SessionMessage.ID.make("msg_1"),
  endMessageID: SessionMessage.ID.make("msg_5"),
  summary: "The parser was read and migrated.",
  createdAt: 0,
  sourceMessageCount: 4,
  sourceTokenCount: 1_200,
  summaryTokenCount: 20,
  nested: [],
}

const preparedWithProtectedRange = () => {
  const protection = ContextProtection.resolve(withProtectedRange, {
    policy: { ...settings.protection, recentTurns: 1 },
  })
  const placed = ContextPlaceholder.apply(sessionID, withProtectedRange, [spanning], protection.messageIDs)
  return placed.messages
}

describe("compressed range containing a protected tool interaction", () => {
  test("keeps the retained turn in canonical order and out of the summary", () => {
    const messages = preparedWithProtectedRange()

    expect(messages.map((message) => message.id)).toEqual([
      SessionMessage.ID.make("msg_cmp_2"),
      SessionMessage.ID.make("msg_4"),
      SessionMessage.ID.make("msg_6"),
      SessionMessage.ID.make("msg_7"),
    ])
    expect(ContextInvariants.check(withProtectedRange, messages)).toEqual([])
  })

  test("openai pairs the retained tool call with its result across the placeholder", async () => {
    const openai = await body(
      OpenAIChat.route.with({ limits }),
      OpenAIChat.protocol.body.from,
      preparedWithProtectedRange(),
    )

    expect(openai.messages[0]?.role).toBe("system")
    expect(openai.messages[1]?.role).toBe("user")
    expect(JSON.stringify(openai.messages[1]?.content)).toContain(PLACEHOLDER)
    expect(openai.messages.filter((message) => message.role === "system")).toHaveLength(1)

    // A tool result must directly follow the assistant message that issued its call.
    openai.messages.forEach((message, index) => {
      if (message.role !== "assistant") return
      const calls = message.tool_calls ?? []
      if (calls.length === 0) return
      const following = openai.messages.slice(index + 1, index + 1 + calls.length)
      expect(following.map((item) => item.role)).toEqual(calls.map(() => "tool"))
      expect(following.map((item) => (item.role === "tool" ? item.tool_call_id : undefined))).toEqual(
        calls.map((call) => call.id),
      )
    })
    expect(JSON.stringify(openai.messages)).toContain("migrate the parser")
  })

  test("anthropic answers the retained tool_use in the next user message", async () => {
    const anthropic = await body(
      AnthropicMessages.route.with({ limits }),
      AnthropicMessages.protocol.body.from,
      preparedWithProtectedRange(),
    )

    expect(anthropic.messages[0]?.role).toBe("user")
    const parts = (message: (typeof anthropic.messages)[number]) =>
      typeof message.content === "string" ? [] : message.content

    anthropic.messages.forEach((message, index) => {
      const uses = parts(message).flatMap((part) => (part.type === "tool_use" ? [part.id] : []))
      if (uses.length === 0) return
      const next = anthropic.messages[index + 1]
      expect(next?.role).toBe("user")
      expect(parts(next!).flatMap((part) => (part.type === "tool_result" ? [part.tool_use_id] : []))).toEqual(uses)
    })
  })

  test("gemini answers the retained function call in the next content block", async () => {
    const gemini = await body(Gemini.route.with({ limits }), Gemini.protocol.body.from, preparedWithProtectedRange())

    expect(gemini.contents[0]?.role).toBe("user")
    gemini.contents.forEach((content, index) => {
      const calls = content.parts.flatMap((part) =>
        "functionCall" in part && part.functionCall ? [part.functionCall.name] : [],
      )
      if (calls.length === 0) return
      const next = gemini.contents[index + 1]
      expect(next?.role).toBe("user")
      expect(
        (next?.parts ?? []).flatMap((part) =>
          "functionResponse" in part && part.functionResponse ? [part.functionResponse.name] : [],
        ),
      ).toEqual(calls)
    })
  })
})
