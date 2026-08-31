/**
 * Regression tests for stale retries continuing with the old model
 * after a real-time model switch.
 *
 * See: https://github.com/mdev34-lab/alphacode/issues/66
 *
 * The bug: when an LLM request fails and the retry/backoff begins, if the
 * user switches to another model/provider via session.update, the retry
 * loop kept using the stale model because streamInput was captured in a
 * closure. The fix adds an `invalidate` hook to SessionRetry.policy that
 * checks the current session model during each retry delay step.
 */
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Layer } from "effect"
import type { Agent } from "../../src/agent/agent"

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

const altRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model-alt"),
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
        "test-model-alt": {
          id: "test-model-alt",
          name: "Test Model Alt",
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

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function testAgent(): Agent.Info {
  return {
    name: "work",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

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
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const createUser = Effect.fn("test.createUser")(function* (sessionID: SessionID, text: string) {
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

const createAssistant = Effect.fn("test.createAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  modelRef = ref,
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
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session.processor model-switch during retry", () => {
  it.live("request failure → retry pending → model switch → processor returns continue (not stop)", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // First call: 503 (retryable), then succeed on second call
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.text("recovered")

          const chat = yield* session.create({})
          // Set the initial model on the session
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })
          const parent = yield* createUser(chat.id, "switch model during retry")
          const msg = yield* createAssistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          // Fork the process so we can switch the model during retry backoff
          const fiber = yield* handle
            .process({
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
              agent: testAgent(),
              system: [],
              messages: [{ role: "user", content: "switch model during retry" }],
              tools: {},
            })
            .pipe(Effect.fork)

          // Wait for the first (failed) attempt and retry status
          yield* llm.wait(1)
          // Give the retry policy a moment to evaluate invalidation
          yield* Effect.sleep("50 millis")

          // Switch the model on the session mid-retry
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: altRef.modelID, providerID: altRef.providerID, variant: "default" },
            time: Date.now(),
          })

          const value = yield* Effect.join(fiber)

          // The processor should return "continue" (not "stop") because the
          // retry was invalidated by the model switch.
          expect(value).toBe("continue")
          // Only one LLM call should have been made (the first failed one)
          // because the retry was cancelled before it could retry.
          expect(yield* llm.calls).toBe(1)
          // The assistant message should NOT have an error set
          expect(handle.message.error).toBeUndefined()
        }),
      { config: (url) => providerCfg(url) },
    ),
  )

  it.live("model switch during long backoff cancels retry promptly (not after full delay)", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // Use a long retry-after header to verify mid-backoff cancellation
          // The test will switch the model after 500ms and verify the processor
          // returns quickly (not after the full 2000ms delay)
          yield* llm.error(503, { error: "service unavailable" }, { "retry-after-ms": "2000" })

          const chat = yield* session.create({})
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })
          const parent = yield* createUser(chat.id, "mid-backoff cancel")
          const msg = yield* createAssistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const start = yield* Effect.sync(() => Date.now())

          // Fork the process
          const fiber = yield* handle
            .process({
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
              agent: testAgent(),
              system: [],
              messages: [{ role: "user", content: "mid-backoff cancel" }],
              tools: {},
            })
            .pipe(Effect.fork)

          // Wait for the first (failed) attempt
          yield* llm.wait(1)
          // Give the retry policy time to start the backoff
          yield* Effect.sleep("100 millis")

          // Switch the model after 500ms (well within the 2000ms backoff)
          yield* Effect.sleep("400 millis")
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: altRef.modelID, providerID: altRef.providerID, variant: "default" },
            time: Date.now(),
          })

          const value = yield* Effect.join(fiber)
          const elapsed = Date.now() - (yield* Effect.sync(() => start))

          // The processor should return "continue" because the retry was
          // invalidated by the model switch during the backoff
          expect(value).toBe("continue")
          // Only one LLM call (the first failed one) because the retry
          // was cancelled mid-backoff
          expect(yield* llm.calls).toBe(1)
          // The elapsed time should be well under the full 2000ms backoff
          // (should be around 500-700ms: 100ms wait + 400ms wait + 200ms poll)
          expect(elapsed).toBeLessThan(1500)
          expect(elapsed).toBeGreaterThanOrEqual(500)
        }),
      { config: (url) => providerCfg(url) },
    ),
  )

  it.live("no model switch → existing retry behavior unchanged", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // First call fails, second succeeds
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.text("recovered")

          const chat = yield* session.create({})
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })
          const parent = yield* createUser(chat.id, "no model switch")
          const msg = yield* createAssistant(chat.id, parent.id, path.resolve(dir))
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
            agent: testAgent(),
            system: [],
            messages: [{ role: "user", content: "no model switch" }],
            tools: {},
          })

          // Normal retry: first call fails, retries, second succeeds
          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(2)
          // The message should have text from the successful retry
          const parts = yield* MessageV2.parts(msg.id)
          expect(parts.some((p) => p.type === "text" && p.text === "recovered")).toBe(true)
        }),
      { config: (url) => providerCfg(url) },
    ),
  )

  it.live("rapid model changes → latest valid selection wins", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // Always fail - we're testing that retry stops after model switch
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.error(503, { error: "service unavailable" })

          const chat = yield* session.create({})
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })
          const parent = yield* createUser(chat.id, "rapid model switch")
          const msg = yield* createAssistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const fiber = yield* handle
            .process({
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
              agent: testAgent(),
              system: [],
              messages: [{ role: "user", content: "rapid model switch" }],
              tools: {},
            })
            .pipe(Effect.fork)

          yield* llm.wait(1)
          yield* Effect.sleep("50 millis")

          // Switch model multiple times rapidly - the final one should win
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: ref.modelID, providerID: altRef.providerID, variant: "default" },
            time: Date.now(),
          })
          yield* session.setAgentModel({
            sessionID: chat.id,
            agent: "work",
            model: { id: altRef.modelID, providerID: altRef.providerID, variant: "default" },
            time: Date.now(),
          })

          const value = yield* Effect.join(fiber)

          // Retry was invalidated by model switch
          expect(value).toBe("continue")
          // Only one LLM call: the first failed one (retry was cancelled)
          expect(yield* llm.calls).toBe(1)
        }),
      { config: (url) => providerCfg(url) },
    ),
  )

  it.live("session isolation: model switch on one session does not affect another", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // Both sessions: first call fails, second succeeds
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.text("session-a-recovered")
          yield* llm.error(503, { error: "service unavailable" })
          yield* llm.text("session-b-recovered")

          // Session A: will have its model switched during retry
          const chatA = yield* session.create({})
          yield* session.setAgentModel({
            sessionID: chatA.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })

          // Session B: will NOT have its model switched
          const chatB = yield* session.create({})
          yield* session.setAgentModel({
            sessionID: chatB.id,
            agent: "work",
            model: { id: ref.modelID, providerID: ref.providerID, variant: "default" },
            time: Date.now(),
          })

          const parentA = yield* createUser(chatA.id, "session a")
          const msgA = yield* createAssistant(chatA.id, parentA.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handleA = yield* processors.create({
            assistantMessage: msgA,
            sessionID: chatA.id,
            model: mdl,
          })

          const parentB = yield* createUser(chatB.id, "session b")
          const msgB = yield* createAssistant(chatB.id, parentB.id, path.resolve(dir))
          const handleB = yield* processors.create({
            assistantMessage: msgB,
            sessionID: chatB.id,
            model: mdl,
          })

          // Fork session A's processing
          const fiberA = yield* handleA
            .process({
              user: {
                id: parentA.id,
                sessionID: chatA.id,
                role: "user",
                time: parentA.time,
                agent: parentA.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chatA.id,
              model: mdl,
              agent: testAgent(),
              system: [],
              messages: [{ role: "user", content: "session a" }],
              tools: {},
            })
            .pipe(Effect.fork)

          // Switch model only on session A
          yield* Effect.sleep("100 millis")
          yield* session.setAgentModel({
            sessionID: chatA.id,
            agent: "work",
            model: { id: altRef.modelID, providerID: altRef.providerID, variant: "default" },
            time: Date.now(),
          })

          // Process session B normally (no model switch)
          const valueB = yield* handleB.process({
            user: {
              id: parentB.id,
              sessionID: chatB.id,
              role: "user",
              time: parentB.time,
              agent: parentB.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chatB.id,
            model: mdl,
            agent: testAgent(),
            system: [],
            messages: [{ role: "user", content: "session b" }],
            tools: {},
          })

          const valueA = yield* Effect.join(fiberA)

          // Session A: retry was invalidated by model switch → "continue"
          expect(valueA).toBe("continue")
          // Session B: normal retry behavior → succeeded
          expect(valueB).toBe("continue")
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
})
