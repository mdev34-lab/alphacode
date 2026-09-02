import { expect, describe, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { Message, Model, SystemPart } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ContextBudget } from "@opencode-ai/core/context/budget"
import { ContextCompressor } from "@opencode-ai/core/context/compressor"
import { ContextDeduplicate } from "@opencode-ai/core/context/deduplicate"
import { ContextInvariants } from "@opencode-ai/core/context/invariants"
import { ContextPlaceholder } from "@opencode-ai/core/context/placeholders"
import { ContextProtection } from "@opencode-ai/core/context/protection"
import { ContextPurgeErrors } from "@opencode-ai/core/context/purge-errors"
import { ContextSettings } from "@opencode-ai/core/context/settings"
import { ContextTypes } from "@opencode-ai/core/context/types"
import { Config } from "@opencode-ai/core/config"
import { ConfigContext } from "@opencode-ai/core/config/context"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"

const sessionID = SessionV2.ID.make("ses_context_compiler")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const user = (id: string, text: string): SessionMessage.User => ({
  id: SessionMessage.ID.make(id),
  type: "user",
  text,
  time: { created },
})

/** Long enough that replacing it with a prune marker is an actual saving. */
const OUTPUT = "a line of recorded tool output\n".repeat(8)

const tool = (input: {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly output?: string
  readonly error?: string
}): SessionMessage.AssistantTool => ({
  type: "tool",
  id: input.id,
  name: input.name,
  time: { created },
  state:
    input.error === undefined
      ? {
          status: "completed",
          input: input.args,
          structured: {},
          content: [{ type: "text", text: input.output ?? OUTPUT }],
        }
      : {
          status: "error",
          input: input.args,
          structured: {},
          content: [{ type: "text", text: input.error }],
          error: { type: "unknown", message: input.error },
        },
})

const assistant = (id: string, content: readonly SessionMessage.AssistantContent[]): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make(id),
  type: "assistant",
  agent: "build",
  model,
  content: [...content],
  time: { created },
})

const text = (id: string, value: string): SessionMessage.AssistantText => ({ type: "text", id, text: value })

const resolve = (messages: readonly SessionMessage.Message[], policy: Partial<ContextTypes.ProtectionPolicy> = {}) => {
  const merged = { ...ContextProtection.defaultPolicy, recentTurns: 0, ...policy }
  return { policy: merged, protection: ContextProtection.resolve(messages, { policy: merged }) }
}

describe("context deduplication", () => {
  const conversation = [
    user("msg_1", "read the entry point"),
    assistant("msg_2", [
      text("t1", "reading"),
      tool({ id: "call_1", name: "read", args: { filePath: "src/index.ts" } }),
    ]),
    assistant("msg_3", [tool({ id: "call_2", name: "read", args: { filePath: "src/index.ts" } })]),
    assistant("msg_4", [tool({ id: "call_3", name: "read", args: { filePath: "src/index.ts" } })]),
    assistant("msg_5", [tool({ id: "call_4", name: "read", args: { filePath: "src/other.ts" } })]),
  ]

  test("keeps only the newest result of an identical repeated call", () => {
    const { policy, protection } = resolve(conversation)
    const pruned = ContextDeduplicate.plan(conversation, { policy, protection })

    expect([...pruned].toSorted()).toEqual(["call_1", "call_2"])

    const prepared = ContextDeduplicate.apply(conversation, pruned)
    const outputs = prepared.flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) =>
            part.type === "tool" && part.state.status === "completed"
              ? [[part.id, part.state.content.map((item) => (item.type === "text" ? item.text : "")).join("")]]
              : [],
          )
        : [],
    )
    expect(outputs).toEqual([
      ["call_1", ContextDeduplicate.MARKER],
      ["call_2", ContextDeduplicate.MARKER],
      ["call_3", OUTPUT],
      ["call_4", OUTPUT],
    ])
  })

  test("never deduplicates different arguments, state-changing tools, or opted-out tools", () => {
    const messages = [
      assistant("msg_1", [tool({ id: "call_1", name: "bash", args: { command: "ls" } })]),
      assistant("msg_2", [tool({ id: "call_2", name: "bash", args: { command: "ls" } })]),
      assistant("msg_3", [tool({ id: "call_3", name: "grep", args: { pattern: "a" } })]),
      assistant("msg_4", [tool({ id: "call_4", name: "grep", args: { pattern: "b" } })]),
      assistant("msg_5", [tool({ id: "call_5", name: "lookup", args: { key: "a" } })]),
      assistant("msg_6", [tool({ id: "call_6", name: "lookup", args: { key: "a" } })]),
    ]
    const { policy, protection } = resolve(messages)

    expect(
      ContextDeduplicate.plan(messages, {
        policy,
        protection,
        toolPolicies: { lookup: { deduplicate: false } },
      }),
    ).toEqual(new Set())
  })

  test("leaves an output alone when the prune marker would be longer than it", () => {
    const messages = [
      assistant("msg_1", [tool({ id: "call_1", name: "read", args: { filePath: "a.ts" }, output: "1" })]),
      assistant("msg_2", [tool({ id: "call_2", name: "read", args: { filePath: "a.ts" }, output: "1" })]),
    ]
    const { policy, protection } = resolve(messages)

    expect(ContextDeduplicate.plan(messages, { policy, protection })).toEqual(new Set())
  })

  test("normalizes argument order before comparing calls", () => {
    const messages = [
      assistant("msg_1", [tool({ id: "call_1", name: "read", args: { limit: 10, filePath: "a.ts" } })]),
      assistant("msg_2", [tool({ id: "call_2", name: "read", args: { filePath: "a.ts", limit: 10 } })]),
    ]
    const { policy, protection } = resolve(messages)

    expect(ContextDeduplicate.plan(messages, { policy, protection })).toEqual(new Set(["call_1"]))
  })
})

describe("context error purging", () => {
  const huge = "x".repeat(5_000)
  const conversation = [
    user("msg_1", "run the generated script"),
    assistant("msg_2", [
      tool({ id: "call_1", name: "bash", args: { command: huge }, error: "exit code 1: syntax error" }),
    ]),
    user("msg_3", "try again"),
    assistant("msg_4", [text("t1", "retrying")]),
    user("msg_5", "and again"),
    assistant("msg_6", [text("t2", "done")]),
  ]

  test("removes the stale input while keeping the failure", () => {
    const purged = ContextPurgeErrors.plan(conversation, {
      policy: ContextProtection.defaultPolicy,
      turns: 1,
    })
    expect(purged).toEqual(new Set(["call_1"]))

    const prepared = ContextPurgeErrors.apply(conversation, purged)
    const failed = prepared[1]!
    if (failed.type !== "assistant") throw new Error("expected an assistant message")
    const part = failed.content[0]!
    if (part.type !== "tool" || part.state.status !== "error") throw new Error("expected a failed tool call")
    expect(part.state.input).toEqual({ purged: ContextPurgeErrors.MARKER })
    expect(part.state.error.message).toBe("exit code 1: syntax error")
    expect(JSON.stringify(prepared)).not.toContain(huge)
  })

  test("retains the input inside the retention window", () => {
    expect(ContextPurgeErrors.plan(conversation, { policy: ContextProtection.defaultPolicy, turns: 4 })).toEqual(
      new Set(),
    )
  })

  test("leaves small failed inputs alone", () => {
    const messages = [
      assistant("msg_1", [tool({ id: "call_1", name: "bash", args: { command: "ls" }, error: "boom" })]),
      assistant("msg_2", [text("t1", "ok")]),
    ]
    expect(ContextPurgeErrors.plan(messages, { policy: ContextProtection.defaultPolicy, turns: 0 })).toEqual(new Set())
  })
})

describe("context protection", () => {
  const conversation = [
    user("msg_1", "start"),
    assistant("msg_2", [tool({ id: "call_1", name: "read", args: { filePath: "package.json" } })]),
    user("msg_3", "continue"),
    assistant("msg_4", [tool({ id: "call_2", name: "read", args: { filePath: "src/a.ts" } })]),
    user("msg_5", "finish"),
    assistant("msg_6", [text("t1", "done")]),
  ]

  test("protects the configured number of recent turns", () => {
    const protection = ContextProtection.resolve(conversation, {
      policy: { ...ContextProtection.defaultPolicy, recentTurns: 1 },
    })
    expect(protection.recentFrom).toBe(4)
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_5"))).toBe(true)
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_1"))).toBe(false)
    expect(protection.callIDs.has("call_1")).toBe(false)
  })

  test("protects declared tools, file patterns, and optionally user messages", () => {
    const protection = ContextProtection.resolve(conversation, {
      policy: {
        ...ContextProtection.defaultPolicy,
        recentTurns: 0,
        userMessages: true,
        filePatterns: ["**/package.json"],
      },
      toolPolicies: { read: { protect: false } },
    })
    expect(protection.callIDs.has("call_1")).toBe(true)
    expect(protection.callIDs.has("call_2")).toBe(false)
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_1"))).toBe(true)
  })

  test("protects the message that carries a protected tool call, not only its output", () => {
    const protection = ContextProtection.resolve(
      [
        user("msg_1", "start"),
        assistant("msg_2", [tool({ id: "call_1", name: "todowrite", args: { todos: [] } })]),
        user("msg_3", "continue"),
        assistant("msg_4", [text("t1", "done")]),
      ],
      { policy: { ...ContextProtection.defaultPolicy, recentTurns: 0 } },
    )
    expect(protection.callIDs.has("call_1")).toBe(true)
    // Compression consults messageIDs, so a protected call must protect its message too.
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_2"))).toBe(true)
  })

  test("always keeps the newest user and assistant message", () => {
    const protection = ContextProtection.resolve(conversation, {
      policy: { ...ContextProtection.defaultPolicy, recentTurns: 0 },
    })
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_5"))).toBe(true)
    expect(protection.messageIDs.has(SessionMessage.ID.make("msg_6"))).toBe(true)
  })
})

describe("compression placeholders", () => {
  const block = (input: {
    readonly id: string
    readonly start: string
    readonly end: string
    readonly summary: string
    readonly createdAt?: number
  }): ContextTypes.CompressionBlock => ({
    id: input.id,
    startMessageID: SessionMessage.ID.make(input.start),
    endMessageID: SessionMessage.ID.make(input.end),
    summary: input.summary,
    createdAt: input.createdAt ?? 1,
    sourceMessageCount: 2,
    sourceTokenCount: 400,
    summaryTokenCount: 40,
    nested: [],
  })

  const conversation = [
    user("msg_1", "one"),
    assistant("msg_2", [text("t1", "two")]),
    user("msg_3", "three"),
    assistant("msg_4", [text("t2", "four")]),
    user("msg_5", "five"),
    assistant("msg_6", [text("t3", "six")]),
  ]

  test("replaces a compressed range with one deterministic placeholder", () => {
    const applied = ContextPlaceholder.apply(sessionID, conversation, [
      block({ id: "cmp_1", start: "msg_1", end: "msg_4", summary: "did the setup" }),
    ])

    expect(applied.messages.map((message) => message.id)).toEqual([
      SessionMessage.ID.make("msg_cmp_1"),
      SessionMessage.ID.make("msg_5"),
      SessionMessage.ID.make("msg_6"),
    ])
    const placeholder = applied.messages[0]!
    if (placeholder.type !== "synthetic") throw new Error("expected a synthetic placeholder")
    expect(placeholder.text).toContain("did the setup")
    expect(placeholder.text).toContain("msg_1-msg_4")
    expect(applied.compressedMessages).toBe(4)
    // Stable across renders so the request prefix stays cacheable.
    expect(
      ContextPlaceholder.apply(sessionID, conversation, [
        block({ id: "cmp_1", start: "msg_1", end: "msg_4", summary: "did the setup" }),
      ]).messages[0],
    ).toEqual(placeholder)
  })

  test("keeps protected messages inside a compressed range verbatim", () => {
    const applied = ContextPlaceholder.apply(
      sessionID,
      conversation,
      [block({ id: "cmp_1", start: "msg_1", end: "msg_4", summary: "did the setup" })],
      new Set([SessionMessage.ID.make("msg_3")]),
    )
    expect(applied.messages.map((message) => message.id)).toEqual([
      SessionMessage.ID.make("msg_cmp_1"),
      SessionMessage.ID.make("msg_3"),
      SessionMessage.ID.make("msg_5"),
      SessionMessage.ID.make("msg_6"),
    ])
  })

  test("a wider later compression supersedes the block nested inside it", () => {
    const inner = block({ id: "cmp_1", start: "msg_2", end: "msg_3", summary: "inner", createdAt: 1 })
    const outer = block({ id: "cmp_2", start: "msg_1", end: "msg_5", summary: "outer", createdAt: 2 })
    const applied = ContextPlaceholder.apply(sessionID, conversation, [inner, outer])

    expect(applied.blocks.map((item) => item.id)).toEqual(["cmp_2"])
    expect(applied.messages.map((message) => message.id)).toEqual([
      SessionMessage.ID.make("msg_cmp_2"),
      SessionMessage.ID.make("msg_6"),
    ])
  })

  test("keeps both summaries when two compressed ranges partially overlap", () => {
    const first = block({ id: "cmp_1", start: "msg_1", end: "msg_3", summary: "first half", createdAt: 1 })
    const second = block({ id: "cmp_2", start: "msg_2", end: "msg_5", summary: "second half", createdAt: 2 })
    const applied = ContextPlaceholder.apply(sessionID, conversation, [first, second])

    // Neither block contains the other, so dropping one would strand its summary forever.
    expect(applied.blocks.map((item) => item.id)).toEqual(["cmp_1", "cmp_2"])
    expect(applied.messages.map((message) => message.id)).toEqual([
      SessionMessage.ID.make("msg_cmp_1"),
      SessionMessage.ID.make("msg_cmp_2"),
      SessionMessage.ID.make("msg_6"),
    ])
    // The overlapping message must be summarized, not duplicated.
    expect(applied.compressedMessages).toBe(5)
    expect(applied.stale).toEqual([])
  })

  test("reports blocks whose boundaries no longer exist as stale instead of failing", () => {
    const applied = ContextPlaceholder.apply(sessionID, conversation, [
      block({ id: "cmp_1", start: "msg_gone", end: "msg_also_gone", summary: "compacted away" }),
    ])
    expect(applied.messages).toEqual(conversation)
    expect(applied.stale.map((item) => item.id)).toEqual(["cmp_1"])
  })

  test("reports a block as stale when only one of its boundaries survives", () => {
    const applied = ContextPlaceholder.apply(sessionID, conversation, [
      block({ id: "cmp_1", start: "msg_2", end: "msg_gone", summary: "half compacted" }),
      block({ id: "cmp_2", start: "msg_4", end: "msg_3", summary: "inverted" }),
    ])
    // A half-anchored or inverted block can never be projected, so it must be cleaned up.
    expect(applied.messages).toEqual(conversation)
    expect(applied.stale.map((item) => item.id)).toEqual(["cmp_1", "cmp_2"])
  })
})

describe("compression prompt", () => {
  test("asks for a technical state summary and carries nested summaries forward", () => {
    const prompt = ContextCompressor.buildPrompt({
      messages: [user("msg_1", "add auth"), assistant("msg_2", [text("t1", "added auth")])],
      focus: "unresolved issues",
      nested: ["earlier summary"],
    })

    expect(prompt).toContain("technical state summary")
    expect(prompt).toContain("<prior-summaries>\nearlier summary\n</prior-summaries>")
    expect(prompt).toContain("[User]: add auth")
    expect(prompt).toContain("Focus the summary on: unresolved issues")
    expect(prompt.indexOf("<prior-summaries>")).toBeLessThan(prompt.indexOf("<transcript>"))
  })
})

describe("compression output budget", () => {
  const events = (text: string) => [
    { type: "text-delta" as const, id: "t1", text },
    { type: "finish" as const, reason: "stop" as const },
  ]

  test("caps a stored summary at the compression output budget", async () => {
    const oversized = "s".repeat(ContextCompressor.MAX_SUMMARY_CHARS * 2)
    const summary = await Effect.runPromise(
      ContextCompressor.summarize(
        { stream: () => Stream.fromIterable(events(oversized)) as never },
        {
          model: Model.make({
            id: "fake-model",
            provider: "fake",
            route: OpenAIChat.route.with({ limits: { context: 200_000, output: 8_000 } }),
          }),
          messages: [user("msg_1", "hello")],
        },
      ),
    )

    expect(summary).toBeDefined()
    expect(summary!.length).toBe(ContextCompressor.MAX_SUMMARY_CHARS + ContextCompressor.TRUNCATED_MARKER.length + 1)
    expect(summary!.endsWith(ContextCompressor.TRUNCATED_MARKER)).toBe(true)
  })

  test("returns a short summary unchanged", async () => {
    const summary = await Effect.runPromise(
      ContextCompressor.summarize(
        { stream: () => Stream.fromIterable(events("  a terse summary  ")) as never },
        {
          model: Model.make({
            id: "fake-model",
            provider: "fake",
            route: OpenAIChat.route.with({ limits: { context: 200_000, output: 8_000 } }),
          }),
          messages: [user("msg_1", "hello")],
        },
      ),
    )

    expect(summary).toBe("a terse summary")
  })
})

describe("context invariants", () => {
  const conversation = [
    user("msg_1", "hello"),
    assistant("msg_2", [text("t1", "hi"), tool({ id: "call_1", name: "read", args: { filePath: "a.ts" } })]),
    user("msg_3", "again"),
    assistant("msg_4", [text("t2", "done")]),
  ]

  test("accepts pruning that only reduces recorded tool results", () => {
    const { policy, protection } = resolve(conversation)
    const prepared = ContextDeduplicate.apply(conversation, new Set(["call_1"]))
    expect(ContextProtection.isDeduplicable("read", policy)).toBe(true)
    expect(protection.callIDs.has("call_1")).toBe(false)
    expect(ContextInvariants.check(conversation, prepared)).toEqual([])
  })

  test("rejects a fabricated assistant message", () => {
    const prepared = [...conversation, assistant("msg_5", [text("t3", "Context was compressed...")])]
    expect(ContextInvariants.check(conversation, prepared)).toEqual([
      "prepared context contains more assistant messages than the session history",
      "synthetic assistant message msg_5",
    ])
    expect(() => ContextInvariants.assertNoSyntheticAssistantContent(conversation, prepared)).toThrow(
      /synthetic assistant message/,
    )
  })

  test("rejects a fabricated assistant tool call", () => {
    const prepared = conversation.map((message) =>
      message.id === "msg_4" && message.type === "assistant"
        ? { ...message, content: [...message.content, tool({ id: "call_x", name: "compress", args: {} })] }
        : message,
    )
    expect(ContextInvariants.check(conversation, prepared)).toEqual([
      "assistant message msg_4 changed its content shape",
    ])
  })

  test("rejects rewritten model text", () => {
    const prepared = conversation.map((message) =>
      message.id === "msg_4" && message.type === "assistant"
        ? { ...message, content: [text("t2", "context pruned")] as SessionMessage.AssistantContent[] }
        : message,
    )
    expect(ContextInvariants.check(conversation, prepared)).toEqual(["assistant message msg_4 rewrote model text"])
  })

  test("rejects a tool result rewritten outside a known reduction", () => {
    const rewritten = conversation.map((message) =>
      message.id !== SessionMessage.ID.make("msg_2")
        ? message
        : assistant("msg_2", [
            text("t1", "hi"),
            tool({ id: "call_1", name: "read", args: { filePath: "a.ts" }, output: "a summary of the file" }),
          ]),
    )
    expect(ContextInvariants.check(conversation, rewritten)).toEqual([
      "assistant message msg_2 rewrote tool call call_1 outside a known reduction",
    ])
  })

  test("accepts the payload-budget truncation and the superseded todo marker", () => {
    const long = assistant("msg_2", [
      text("t1", "hi"),
      tool({
        id: "call_1",
        name: "read",
        args: { filePath: "a.ts" },
        output: `${"head".repeat(200)}${"tail".repeat(200)}`,
      }),
    ])
    const source = [conversation[0]!, long, ...conversation.slice(2)]
    const truncated = [
      conversation[0]!,
      assistant("msg_2", [
        text("t1", "hi"),
        tool({
          id: "call_1",
          name: "read",
          args: { filePath: "a.ts" },
          output: `${"head".repeat(10)}\n${ContextBudget.TRUNCATED_MARKER}\n${"tail".repeat(10)}`,
        }),
      ]),
      ...conversation.slice(2),
    ]
    expect(ContextInvariants.check(source, truncated)).toEqual([])
  })

  test("rejects a reordered prepared context", () => {
    const reordered = [conversation[2]!, conversation[0]!, conversation[1]!, conversation[3]!]
    expect(ContextInvariants.check(conversation, reordered)).toEqual([
      "prepared context reordered message msg_1",
      "prepared context reordered message msg_2",
    ])
  })

  test("rejects an appended system message", () => {
    const prepared: SessionMessage.Message[] = [
      ...conversation,
      { id: SessionMessage.ID.make("msg_sys"), type: "system", text: "context was pruned", time: { created } },
    ]
    expect(ContextInvariants.check(conversation, prepared)).toEqual([
      "synthetic system message msg_sys",
      "prepared context appended a system message",
    ])
  })

  test("accepts a compression placeholder", () => {
    const prepared = ContextPlaceholder.apply(sessionID, conversation, [
      {
        id: "cmp_9",
        startMessageID: SessionMessage.ID.make("msg_1"),
        endMessageID: SessionMessage.ID.make("msg_2"),
        summary: "earlier work",
        createdAt: 1,
        sourceMessageCount: 2,
        sourceTokenCount: 100,
        summaryTokenCount: 10,
        nested: [],
      },
    ])
    expect(ContextInvariants.check(conversation, prepared.messages)).toEqual([])
  })
})

describe("context budget", () => {
  const compression = {
    enabled: true,
    mode: "range" as const,
    automatic: true,
    minContext: 0.6,
    maxContext: 0.85,
    timeoutMillis: 90_000,
  }

  test("maps utilization onto the configured policy bands", () => {
    expect(ContextBudget.recommend(0.4, compression)).toBe("none")
    expect(ContextBudget.recommend(0.7, compression)).toBe("normal")
    expect(ContextBudget.recommend(0.8, compression)).toBe("nudge")
    expect(ContextBudget.recommend(0.87, compression)).toBe("prefer")
    expect(ContextBudget.recommend(0.95, compression)).toBe("mandatory")
  })

  test("measures the system prompt and tool definitions as part of the request", () => {
    expect(ContextBudget.envelope(undefined)).toEqual({ tokens: 0, bytes: 0 })
    const cost = ContextBudget.envelope({
      system: [SystemPart.make("You are a coding agent.".repeat(20))],
      tools: [{ name: "read", parameters: { filePath: "string" } }],
      extra: [Message.assistant("max steps reached")],
    })
    expect(cost.tokens).toBeGreaterThan(0)
    expect(cost.bytes).toBeGreaterThan(cost.tokens)
    // Whatever the runner puts in the request is what gets measured, message shape included.
    expect(cost.bytes).toBeGreaterThan(
      ContextBudget.envelope({ system: [SystemPart.make("You are a coding agent.".repeat(20))] }).bytes,
    )
  })

  test("drops the oldest messages without letting the protected window shift into range", () => {
    const large = "z".repeat(2_000)
    const messages = [
      user("msg_1", large),
      assistant("msg_2", [text("t1", large)]),
      user("msg_3", large),
      assistant("msg_4", [text("t2", large)]),
      user("msg_5", large),
      assistant("msg_6", [text("t3", large)]),
      user("msg_7", "the question that must survive"),
      assistant("msg_8", [text("t4", "answering")]),
    ]
    const { policy, protection } = resolve(messages, { recentTurns: 2 })
    expect(protection.recentFrom).toBe(4)

    const result = ContextBudget.reduce({ messages, policy, protection, limit: 1_000 })
    // Dropping shifts every later message one index to the left, so the eligible prefix is decided
    // once, up front: the whole recent window survives no matter how many messages disappear.
    expect(result.messages.map((message) => message.id)).toEqual(messages.slice(4).map((message) => message.id))
    // The eligible prefix ran out while the payload was still too large, which is the signal that
    // only compression can help now.
    expect(result.within).toBe(false)
    expect(result.needsCompression).toBe(true)
    expect(ContextInvariants.check(messages, result.messages)).toEqual([])
  })

  test("reduces an oversized payload in deterministic order without touching protected content", () => {
    const large = "y".repeat(4_000)
    const messages = [
      user("msg_1", "first"),
      assistant("msg_2", [tool({ id: "call_1", name: "read", args: { filePath: "a.ts" }, output: large })]),
      assistant("msg_3", [tool({ id: "call_2", name: "read", args: { filePath: "a.ts" }, output: large })]),
      user("msg_4", "second"),
      assistant("msg_5", [text("t1", "done")]),
    ]
    const { policy, protection } = resolve(messages, { recentTurns: 1 })
    const result = ContextBudget.reduce({ messages, policy, protection, limit: 3_000 })

    expect(result.steps[0]).toBe("deduplicate")
    expect(result.within).toBe(true)
    expect(result.messages.some((message) => message.id === "msg_4")).toBe(true)
    expect(result.messages.some((message) => message.id === "msg_5")).toBe(true)
    expect(ContextInvariants.check(messages, result.messages)).toEqual([])
  })
})

describe("context settings", () => {
  test("uses DCP-compatible defaults", () => {
    expect(ContextSettings.settings([])).toEqual({
      compression: {
        enabled: true,
        mode: "range",
        automatic: true,
        minContext: 0.6,
        maxContext: 0.85,
        timeoutMillis: 90_000,
      },
      deduplication: { enabled: true },
      purgeErrors: { enabled: true, turns: 4 },
      protection: ContextProtection.defaultPolicy,
      payloadBytes: undefined,
    })
  })

  test("applies configuration overrides and extends the protected tool list", () => {
    const resolved = ContextSettings.settings([
      new Config.Document({
        type: "document",
        info: new Config.Info({
          context: new ConfigContext.Info({
            dynamic_compression: new ConfigContext.DynamicCompression({
              enabled: false,
              max_context: 0.9,
              timeout_ms: 15_000,
            }),
            purge_errors: new ConfigContext.PurgeErrors({ turns: 2 }),
            protection: new ConfigContext.Protection({ tools: ["deploy"], user_messages: true }),
            payload_bytes: 1_000,
          }),
        }),
      }),
    ])

    expect(resolved.compression.enabled).toBe(false)
    expect(resolved.compression.maxContext).toBe(0.9)
    expect(resolved.compression.timeoutMillis).toBe(15_000)
    expect(resolved.purgeErrors.turns).toBe(2)
    expect(resolved.protection.userMessages).toBe(true)
    expect(resolved.protection.tools).toContain("deploy")
    expect(resolved.protection.tools).toContain("todowrite")
    expect(resolved.payloadBytes).toBe(1_000)
  })

  test("accumulates protection across configuration documents", () => {
    const document = (tools: readonly string[], files: readonly string[]) =>
      new Config.Document({
        type: "document",
        info: new Config.Info({
          context: new ConfigContext.Info({ protection: new ConfigContext.Protection({ tools, files }) }),
        }),
      })
    const resolved = ContextSettings.settings([document(["deploy"], ["infra/**"]), document(["migrate"], ["ops/**"])])

    // A later document extends protection; it never silently unprotects what an earlier one asked
    // for, and the built-in list survives both.
    expect(resolved.protection.tools).toContain("deploy")
    expect(resolved.protection.tools).toContain("migrate")
    expect(resolved.protection.tools).toContain("todowrite")
    expect(resolved.protection.tools.filter((tool) => tool === "todowrite")).toHaveLength(1)
    expect(resolved.protection.filePatterns).toEqual(["infra/**", "ops/**"])
  })
})
