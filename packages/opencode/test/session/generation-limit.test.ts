import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { GenerationLimit } from "../../src/session/llm/generation-limit"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { it, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const providerID = ProviderV2.ID.make("test")

describe("GenerationLimit.resolveMaxChars", () => {
  test("scales with maxOutputTokens", () => {
    expect(GenerationLimit.resolveMaxChars({ maxOutputTokens: 32_000 })).toBe(
      32_000 * GenerationLimit.CHARS_PER_OUTPUT_TOKEN,
    )
  })

  test("env override wins over the derived default", () => {
    expect(GenerationLimit.resolveMaxChars({ maxOutputTokens: 32_000, override: 1234 })).toBe(1234)
  })

  test("falls back when maxOutputTokens is missing or invalid", () => {
    expect(GenerationLimit.resolveMaxChars({})).toBe(GenerationLimit.GENERATION_CHAR_FALLBACK_MAX)
    expect(GenerationLimit.resolveMaxChars({ maxOutputTokens: 0 })).toBe(GenerationLimit.GENERATION_CHAR_FALLBACK_MAX)
    expect(GenerationLimit.resolveMaxChars({ maxOutputTokens: NaN })).toBe(
      GenerationLimit.GENERATION_CHAR_FALLBACK_MAX,
    )
  })
})

describe("GenerationLimit.guard", () => {
  const text = (length: number, id = "text-1") => LLMEvent.textDelta({ id, text: "x".repeat(length) })
  const reasoning = (length: number, id = "reasoning-1") => LLMEvent.reasoningDelta({ id, text: "x".repeat(length) })
  const toolInput = (length: number, id = "call-1") =>
    LLMEvent.toolInputDelta({ id, name: "lookup", text: "x".repeat(length) })

  it.effect("passes normal generation untouched", () =>
    Effect.gen(function* () {
      const input = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        text(5),
        text(7),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const collected = yield* GenerationLimit.guard(Stream.fromIterable(input), { maxChars: 320_000 }).pipe(
        Stream.runCollect,
      )
      expect(Array.from(collected)).toStrictEqual(input)
    }),
  )

  it.effect("aborts a pathological uninterrupted stream with a clear error", () =>
    Effect.gen(function* () {
      // 50k uninterrupted deltas x 10 chars: the issue #89 shape (M3 stuck
      // generating). Must abort at the cap, not accumulate unboundedly.
      const deltas = Array.from({ length: 50_000 }, () => text(10))
      const source = Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
        Stream.fromIterable(deltas),
      )
      const error = yield* GenerationLimit.guard(source, { maxChars: 320_000 }).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(error).toBeInstanceOf(GenerationLimit.GenerationLimitExceededError)
      if (!(error instanceof GenerationLimit.GenerationLimitExceededError)) return
      expect(error.maxChars).toBe(320_000)
      expect(error.seenChars).toBeGreaterThan(320_000)
      expect(error.message).toContain(GenerationLimit.GENERATION_LIMIT_MESSAGE)
    }),
  )

  it.effect("counts reasoning and tool-input deltas toward the same cap", () =>
    Effect.gen(function* () {
      const source = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        reasoning(60),
        reasoning(50),
        toolInput(10),
      ])
      const error = yield* GenerationLimit.guard(source, { maxChars: 100 }).pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(GenerationLimit.GenerationLimitExceededError)
    }),
  )

  it.effect("does not trip exactly at the cap", () =>
    Effect.gen(function* () {
      const source = Stream.fromIterable([LLMEvent.textDelta({ id: "text-1", text: "x".repeat(100) })])
      const collected = yield* GenerationLimit.guard(source, { maxChars: 100 }).pipe(Stream.runCollect)
      expect(collected.length).toBe(1)
    }),
  )
})

describe("generation-limit retry behavior", () => {
  test("tripped caps surface as a clear non-retryable error, not a hidden failure", () => {
    const parsed = MessageV2.fromError(new GenerationLimit.GenerationLimitExceededError(320_000, 320_010), {
      providerID,
    })
    expect(parsed.name).toBe("UnknownError")
    const message = typeof parsed.data === "object" && parsed.data !== null && "message" in parsed.data
      ? parsed.data.message
      : undefined
    expect(message).toContain(GenerationLimit.GENERATION_LIMIT_MESSAGE)
    expect(SessionRetry.retryable(parsed, "test")).toBeUndefined()
  })

  test("genuinely retryable errors still retry", () => {
    const parsed = MessageV2.fromError(new Error("Rate limit exceeded, please try again later"), { providerID })
    expect(SessionRetry.retryable(parsed, "test")).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Processor regression coverage: a tripped cap must end the turn with a clean
// "stop" (visible error, idle status) and must not re-subscribe/retry the
// runaway stream.
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "work",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "work",
    agent: "work",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

function processorWithLLM(stream: () => Stream.Stream<LLMEvent>) {
  return testEffect(
    LayerNode.compile(root, [
      ...replacements,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream,
          }),
        ),
      ],
    ]),
  )
}

// Counts subscriptions: every retry re-subscribes, so a tripped cap must
// leave this at exactly one (no retry loop over the runaway stream).
const subscriptions = { count: 0 }

const pathologicalStream = () =>
  Stream.concat(
    Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
    Stream.fromIterable(Array.from({ length: 500 }, () => LLMEvent.textDelta({ id: "text-1", text: "x".repeat(1000) }))),
    Stream.fail(new GenerationLimit.GenerationLimitExceededError(320_000, 500_000)),
  )

const itPathological = processorWithLLM(() => {
  subscriptions.count += 1
  return pathologicalStream()
})

itPathological.live("session.processor aborts a tripped generation cap without retrying", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        subscriptions.count = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "runaway")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "runaway" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(subscriptions.count).toBe(1)
        expect(handle.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: expect.stringContaining(GenerationLimit.GENERATION_LIMIT_MESSAGE) },
        })
      }),
    { config: cfg },
  ),
)

const itNormal = processorWithLLM(() =>
  Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text: "hello" }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ),
)

itNormal.live("session.processor leaves normal generation under the cap unaffected", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        expect(value).toBe("continue")
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)
