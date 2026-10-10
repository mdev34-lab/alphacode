import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

// ---------------------------------------------------------------------------
// The race the existing `session.processor preserves child writes with …` tests
// do not reach.
//
// `SessionProcessor.completeToolCall` is a read-modify-write: it reads the tool
// part, merges the child's write evidence into the returned metadata, and
// commits the whole part back. Those tests only cover evidence that is already
// persisted when the read happens - the write lands, then the read picks it up,
// then the commit keeps it.
//
// The child's live projection runs on its own fiber and can land inside that
// window: after the parent's read, before the parent's commit. The commit then
// writes metadata computed from the stale read and erases the evidence. That is
// the lost update tested here.
//
// Nothing in the window is observable from outside, so the interleaving is
// forced by a barrier instead of a sleep: the session store's `getPart` is
// wrapped (the original method is bound, never re-entered) and parks the
// processor's completion read until the test has committed the child's write
// through the real store and bus. `timeline` records the resulting order, so a
// passing run also proves the write really did land between read and commit.
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

function agent(): Agent.Info {
  return {
    name: "work",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A, E>(check: Effect.Effect<A | undefined, E>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 5000
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const isCompletedTool = (part: SessionV1.Part) => part.type === "tool" && part.state.status === "completed"

type Barrier = {
  readonly partID: string
  readonly ready: Deferred.Deferred<void>
  readonly written: Deferred.Deferred<void>
  fired: boolean
}

const timeline: string[] = []
let barrier: Barrier | undefined

// The real session store, built from the same nodes the processor uses. It is a
// separate node only so the wrapper below can depend on it without the
// replacement resolver collapsing the two into a cycle: replacements are
// resolved by name, and a node may not depend on its own name.
const baseSession = LayerNode.make({
  name: "@opencode/Session.base",
  layer: Session.node.implementation!,
  // The dependency list is read straight off the node the wrapper stands in
  // for, so the compiled subtree shares every service instance the rest of the
  // tree uses. `LayerNode` types `deps` as a non-empty tuple; the cast only
  // carries the runtime list across.
  deps: Session.node.dependencies as unknown as [LayerNode.Node<never>],
}) as unknown as LayerNode.Node<Session.Service>

const sessionGate = LayerNode.make({
  service: Session.Service,
  // Only the two methods the race runs through are wrapped, and both delegate
  // to the original bound method, so the real store, the real bus and the real
  // projector still carry every write.
  //
  // `getPart` is instrumented, not parked: the processor reads the part twice on
  // the completion path (once to route the result, once inside the commit), and
  // either read may be the one whose snapshot the commit is computed from. The
  // barrier sits at the commit's own entry, before it has read or written
  // anything - the one moment that is unambiguously "after the parent's reads,
  // before the completion commit". It is installed on `modifyPart` when the
  // store offers one (the atomic commit) and on `updatePart` otherwise, so the
  // same interleaving is forced either way.
  layer: Layer.effect(
    Session.Service,
    Effect.gen(function* () {
      const base = yield* Session.Service
      const getPart = base.getPart.bind(base)
      const updatePart = base.updatePart.bind(base)
      const modifyPart = base.modifyPart?.bind(base)
      const park = (partID: string) =>
        Effect.gen(function* () {
          const gate = barrier
          if (gate && !gate.fired && partID === gate.partID) {
            gate.fired = true
            timeline.push("commit")
            yield* Deferred.succeed(gate.ready, undefined)
            yield* Deferred.await(gate.written)
          }
        })
      return Session.Service.of({
        ...base,
        getPart: (input) =>
          Effect.gen(function* () {
            const part = yield* getPart(input)
            if (barrier?.partID === input.partID) timeline.push("read")
            return part
          }),
        updatePart: (part) =>
          Effect.gen(function* () {
            if (isCompletedTool(part)) yield* park(part.id)
            return yield* updatePart(part)
          }),
        ...(modifyPart
          ? {
              modifyPart: (input, modify) =>
                Effect.gen(function* () {
                  yield* park(input.partID)
                  return yield* modifyPart(input, modify)
                }),
            }
          : {}),
      })
    }),
  ),
  deps: [baseSession],
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

const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Session.node, sessionGate as unknown as LayerNode.Node<Session.Service>],
  ],
)

const it = testEffect(env)

const user = Effect.fn("RaceTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("RaceTest.assistant")(function* (sessionID: SessionID, parentID: MessageID, root: string) {
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

it.live(
  "session.processor keeps child writes that land after the parent read and before the completion commit",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          timeline.length = 0
          const { processors, session, provider } = yield* Effect.all({
            processors: SessionProcessor.Service,
            session: Session.Service,
            provider: Provider.Service,
          })

          yield* llm.tool("lookup", { query: "weather" })

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const delivery = defer<{ title: string; output: string; metadata: Record<string, unknown> }>()
          const run = yield* handle
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
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "tool" }],
              tools: {
                lookup: tool({
                  description: "Look up information",
                  inputSchema: z.object({ query: z.string() }),
                  execute: async () => delivery.promise,
                }),
              },
            })
            .pipe(Effect.forkChild)

          // Arm only once the part is running: the read that follows is the
          // completion read, not the earlier read that turns it running.
          const running = yield* waitFor(
            session
              .messages({ sessionID: chat.id, limit: 50 })
              .pipe(
                Effect.map((messages) =>
                  messages
                    .flatMap((m) => m.parts)
                    .find(
                      (part): part is SessionV1.ToolPart => part.type === "tool" && part.state.status === "running",
                    ),
                ),
              ),
            "timed out waiting for running task",
          )
          if (running.state.status !== "running") throw new Error("expected running tool")
          const ready = yield* Deferred.make<void>()
          const written = yield* Deferred.make<void>()
          barrier = { partID: running.id, ready, written, fired: false }

          delivery.resolve({
            title: "Weather lookup",
            output: "result:weather",
            metadata: {
              source: "returned",
              reviewLoop: { outcome: "background" },
            },
          })

          // The child's write evidence, committed through the real store and
          // bus while the processor's completion commit is parked: after every
          // read it took, before the commit it computed from them is applied.
          yield* Deferred.await(ready)
          yield* session.updatePart({
            ...running,
            state: {
              ...running.state,
              metadata: {
                lateEvidence: "child-write",
                reviewLoop: { writesFiles: true, childSession: "child" },
              },
            },
          })
          timeline.push("write")
          yield* Deferred.succeed(written, undefined)

          const value = yield* Fiber.join(run)
          barrier = undefined

          const parts = yield* MessageV2.parts(msg.id)
          const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

          // Ordering proof: the commit began after the reads, and the child's
          // write landed before that commit was applied.
          expect(timeline.slice(-3)).toEqual(["read", "commit", "write"])
          expect(value).toBe("continue")
          expect(call?.callID).toBe("call_1")
          expect(call?.state.status).toBe("completed")
          if (call?.state.status !== "completed") return
          expect(call.state.output).toBe("result:weather")
          // Same evidence the before-the-read tests keep: the commit must not
          // erase a write it did not see.
          expect(call.state.metadata).toEqual({
            source: "returned",
            lateEvidence: "child-write",
            reviewLoop: {
              writesFiles: true,
              childSession: "child",
              outcome: "background",
            },
          })
        }),
      { config: (url) => providerCfg(url) },
    ),
  { timeout: 30000 },
)
