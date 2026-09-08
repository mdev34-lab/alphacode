import { describe, expect, test } from "bun:test"
import { LLM, Model, SystemPart, type LLMRequest } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as Gemini from "@opencode-ai/llm/protocols/gemini"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ContextBudget } from "@opencode-ai/core/context/budget"
import { ContextDeduplicate } from "@opencode-ai/core/context/deduplicate"
import { ContextInvariants } from "@opencode-ai/core/context/invariants"
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
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { DateTime, Effect } from "effect"

/**
 * Randomized provider-shape testing.
 *
 * Tool-call adjacency is a lowered provider invariant, while compression, protection and pruning
 * all operate on canonical messages. Hand-built cases only prove that the boundaries someone
 * thought of are safe, so this generates conversations and compression boundaries instead, runs the
 * real pipeline over them, lowers the result into three provider bodies, and asserts the invariant
 * every time. A failure prints the seed, which reproduces the case exactly.
 */

const sessionID = SessionSchema.ID.make("ses_provider_property")
const created = DateTime.makeUnsafe(0)
const settings = ContextSettings.settings([])
const limits = { context: 200_000, output: 8_000 }
const fsys = LayerNode.compile(FSUtil.node)

/** Deterministic PRNG so a failing case can be replayed from its seed alone. */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const TOOLS = ["read", "bash", "grep", "todowrite", "write", "task"] as const

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

const conversation = (next: () => number) => {
  const messages: SessionMessage.Message[] = []
  const length = 4 + Math.floor(next() * 11)
  let calls = 0
  for (let index = 0; index < length; index++) {
    const id = `msg_${index + 1}`
    if (next() < 0.35 || index === 0) {
      messages.push(user(id, `step ${index} ${"detail ".repeat(1 + Math.floor(next() * 30))}`))
      continue
    }
    const parts: SessionMessage.Assistant["content"][number][] = []
    if (next() < 0.5) parts.push({ type: "text", id: `t_${index}`, text: `thinking about step ${index}` })
    const toolCount = Math.floor(next() * 4)
    for (let item = 0; item < toolCount; item++) {
      calls++
      const name = TOOLS[Math.floor(next() * TOOLS.length)]
      // Duplicate inputs on purpose: deduplication only fires when two calls agree exactly.
      const failing = next() < 0.25
      // A failed call keeps a large input so that error purging has something worth reclaiming.
      const input = {
        target: `src/file-${Math.floor(next() * 3)}.ts`,
        command: failing ? `run ${"x".repeat(600)}` : `run ${Math.floor(next() * 3)}`,
      }
      parts.push({
        type: "tool",
        id: `call_${calls}`,
        name,
        time: { created },
        state: failing
          ? {
              status: "error",
              input,
              structured: {},
              content: [{ type: "text", text: `exit code 1 ${"x".repeat(600)}` }],
              error: { type: "unknown", message: "exit code 1" },
            }
          : {
              status: "completed",
              input,
              structured: {},
              content: [{ type: "text", text: `output of ${name}\n${"line\n".repeat(40)}` }],
            },
      })
    }
    if (parts.length === 0) parts.push({ type: "text", id: `t_${index}`, text: `answer ${index}` })
    messages.push(assistant(id, parts))
  }
  return messages
}

const blocks = (next: () => number, messages: readonly SessionMessage.Message[]) => {
  const result: ContextTypes.CompressionBlock[] = []
  const count = Math.floor(next() * 4)
  for (let index = 0; index < count; index++) {
    const start = Math.floor(next() * messages.length)
    const end = Math.min(start + Math.floor(next() * 5), messages.length - 1)
    result.push({
      id: `cmp_${index + 1}`,
      startMessageID: messages[start].id,
      endMessageID: messages[end].id,
      summary: `summary ${index} of messages ${start}-${end}`,
      createdAt: index,
      sourceMessageCount: end - start + 1,
      sourceTokenCount: 500,
      summaryTokenCount: 40,
      nested: [],
    })
  }
  return result
}

/** The compiler pipeline exactly as `ContextManager.prepare` runs it. */
const compile = (next: () => number, canonical: readonly SessionMessage.Message[]) => {
  const policy = {
    ...settings.protection,
    recentTurns: Math.floor(next() * 4),
    userMessages: next() < 0.3,
  }
  const protection = ContextProtection.resolve(canonical, { policy })
  const placed = ContextPlaceholder.apply(sessionID, canonical, blocks(next, canonical), protection.messageIDs)
  const duplicates = ContextDeduplicate.plan(placed.messages, { policy, protection })
  const errors = ContextPurgeErrors.plan(placed.messages, { policy, turns: Math.floor(next() * 3) })
  const reduced = ContextPurgeErrors.apply(ContextDeduplicate.apply(placed.messages, duplicates), errors)
  if (next() < 0.4)
    return {
      protection,
      messages: ContextBudget.reduce({
        messages: reduced,
        policy,
        protection,
        limit: Math.max(Math.floor(ContextBudget.bytes(reduced) * next()), 200),
      }).messages,
    }
  return { protection, messages: reduced }
}

const lower = (route: Model["route"], messages: readonly SessionMessage.Message[]) => {
  const model = Model.make({ id: "fake-model", provider: "fake", route })
  return toLLMMessages(messages, model).pipe(
    Effect.map((lowered) =>
      LLM.request({ model, system: [SystemPart.make("baseline")], messages: lowered, tools: [] }),
    ),
    Effect.provide(fsys),
    Effect.orDie,
  )
}

const body = <A>(route: Model["route"], from: (request: LLMRequest) => Effect.Effect<A, unknown>) =>
  Effect.fn(function* (messages: readonly SessionMessage.Message[]) {
    return yield* from(yield* lower(route, messages)).pipe(Effect.orDie)
  })

const openaiBody = body(OpenAIChat.route.with({ limits }), OpenAIChat.protocol.body.from)
const anthropicBody = body(AnthropicMessages.route.with({ limits }), AnthropicMessages.protocol.body.from)
const geminiBody = body(Gemini.route.with({ limits }), Gemini.protocol.body.from)

/**
 * Every result answers the immediately preceding call, and no call goes unanswered.
 *
 * `pending` is the set of calls issued by the last request-bearing message; a message that is
 * neither the answer nor a new request must not appear while it is non-empty.
 */
const assertAdjacency = (
  steps: readonly { readonly calls: readonly string[]; readonly results: readonly string[] }[],
) => {
  let pending: string[] = []
  for (const step of steps) {
    if (step.results.length > 0) {
      expect(step.results).toEqual(pending.slice(0, step.results.length))
      pending = pending.slice(step.results.length)
      if (step.calls.length === 0) continue
    }
    expect(pending).toEqual([])
    pending = [...step.calls]
  }
  expect(pending).toEqual([])
}

const openaiSteps = (messages: readonly Record<string, unknown>[]) =>
  messages.map((message) => ({
    calls:
      message.role === "assistant"
        ? ((message.tool_calls ?? []) as { readonly id: string }[]).map((call) => call.id)
        : [],
    results: message.role === "tool" ? [message.tool_call_id as string] : [],
  }))

type AnthropicBlock = { readonly type: string; readonly id?: string; readonly tool_use_id?: string }

const anthropicSteps = (messages: readonly { readonly content: string | readonly AnthropicBlock[] }[]) =>
  messages.map((message) => {
    const content = typeof message.content === "string" ? [] : message.content
    return {
      calls: content.flatMap((part) => (part.type === "tool_use" ? [part.id!] : [])),
      results: content.flatMap((part) => (part.type === "tool_result" ? [part.tool_use_id!] : [])),
    }
  })

type GeminiPart = {
  readonly functionCall?: { readonly name: string }
  readonly functionResponse?: { readonly name: string }
}

const geminiSteps = (contents: readonly { readonly parts: readonly GeminiPart[] }[]) =>
  contents.map((content) => ({
    calls: content.parts.flatMap((part) => (part.functionCall ? [part.functionCall.name] : [])),
    results: content.parts.flatMap((part) => (part.functionResponse ? [part.functionResponse.name] : [])),
  }))

describe("provider tool adjacency under arbitrary compression boundaries", () => {
  test("holds for every generated conversation, boundary and protection policy", async () => {
    // A generator that stopped producing interesting cases would make this suite pass vacuously.
    const covered = { results: 0, placeholders: 0, retained: 0, pruned: 0, purged: 0 }
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed)
      const canonical = conversation(next)
      const { messages } = compile(next, canonical)
      const context = `seed ${seed}`

      // The compiler itself must never have rewritten the conversation.
      expect(ContextInvariants.check(canonical, messages), context).toEqual([])

      const serialized = JSON.stringify(messages)
      if (serialized.includes("<compressed-conversation-section>")) covered.placeholders++
      if (serialized.includes(ContextDeduplicate.MARKER)) covered.pruned++
      if (serialized.includes(ContextPurgeErrors.MARKER)) covered.purged++
      // A protected message that survived inside a range some placeholder replaced.
      if (
        messages.some((message, index) => index > 0 && messages[index - 1]!.type === "synthetic") &&
        messages.some((message) => message.type === "assistant")
      )
        covered.retained++

      const lowered = await Effect.runPromise(
        toLLMMessages(messages, Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })).pipe(
          Effect.provide(fsys),
          Effect.orDie,
        ),
      )
      const openai = await Effect.runPromise(openaiBody(messages))
      const anthropic = await Effect.runPromise(anthropicBody(messages))
      const gemini = await Effect.runPromise(geminiBody(messages))

      // The same gate the runner runs before transmission, on the same lowering.
      expect(ContextInvariants.pairing(lowered), context).toEqual([])

      assertAdjacency(openaiSteps(openai.messages as never))
      assertAdjacency(anthropicSteps(anthropic.messages as never))
      assertAdjacency(geminiSteps(gemini.contents as never))

      // One system prompt, always first, and never a second one further down the conversation.
      expect(
        openai.messages.filter((message) => message.role === "system"),
        context,
      ).toHaveLength(1)
      expect(openai.messages[0]?.role, context).toBe("system")
      expect(
        anthropic.messages.every((message) => message.role === "user" || message.role === "assistant"),
        context,
      ).toBe(true)
      expect(
        gemini.contents.every((content) => content.role === "user" || content.role === "model"),
        context,
      ).toBe(true)
      // Summaries are historical content, never fabricated assistant turns.
      for (const message of openai.messages)
        if (JSON.stringify(message.content ?? "").includes("<compressed-conversation-section>"))
          expect(message.role, context).toBe("user")

      covered.results += openaiSteps(openai.messages as never).filter((step) => step.results.length > 0).length
    }

    expect(covered.results).toBeGreaterThan(200)
    expect(covered.placeholders).toBeGreaterThan(50)
    expect(covered.retained).toBeGreaterThan(20)
    expect(covered.pruned).toBeGreaterThan(10)
    expect(covered.purged).toBeGreaterThan(10)
  }, 60_000)
})
