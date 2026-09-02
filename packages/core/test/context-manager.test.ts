import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Message, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ConfigAgent } from "@opencode-ai/core/config/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigContext } from "@opencode-ai/core/config/context"
import { ContextBudget } from "@opencode-ai/core/context/budget"
import { ContextDeduplicate } from "@opencode-ai/core/context/deduplicate"
import { ContextManager } from "@opencode-ai/core/context/manager"
import { ContextPurgeErrors } from "@opencode-ai/core/context/purge-errors"
import { ContextState } from "@opencode-ai/core/context/state"
import { SessionContextBlockTable } from "@opencode-ai/core/context/sql"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { CompressTool } from "@opencode-ai/core/tool/compress"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const projectDir = mkdtempSync(path.join(tmpdir(), "alphacode-context-test-"))

const requests: LLMRequest[] = []
let turns: LLMEvent[][] = []
let summary = "## State\n- implemented the authentication flow"
let summaryAvailable = true

/** A compression request is the isolated internal call: one user message and no tools. */
const isCompression = (request: LLMRequest) =>
  request.tools.length === 0 &&
  request.messages.length === 1 &&
  request.messages[0]?.role === "user" &&
  JSON.stringify(request.messages[0]?.content).includes("technical state summary")

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (isCompression(request))
        return Stream.fromIterable<LLMEvent>(
          summaryAvailable
            ? [
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "summary" }),
                LLMEvent.textDelta({ id: "summary", text: summary }),
                LLMEvent.textEnd({ id: "summary" }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ]
            : [LLMEvent.providerError({ message: "summary unavailable" })],
        )
      return Stream.fromIterable(turns.shift() ?? say("Done"))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const say = (text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: `text-${text}` }),
  LLMEvent.textDelta({ id: `text-${text}`, text }),
  LLMEvent.textEnd({ id: `text-${text}` }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const call = (id: string, name: string, input: Record<string, unknown>) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const model = Model.make({
  id: "fake-model",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 200_000, output: 1_000 } }),
})
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

/** Large enough that replacing it with a prune marker is an actual saving. */
const fileBody = (file: string) => `contents of ${file}\n${"export const value = 1\n".repeat(40)}`

const tools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      inspect: Tool.make({
        description: "Read a file",
        input: Schema.Struct({ file: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ file }) => Effect.succeed({ text: fileBody(file) }),
      }),
      generate: Tool.make({
        description: "Run a generated script",
        input: Schema.Struct({ script: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: () => Effect.fail(new Tool.Failure({ message: "exit code 1: syntax error" })),
      }),
      snapshot: Tool.make({
        description: "Record the current plan",
        // Declared protected, exactly like todowrite or task in the real registry.
        contextPolicy: { protect: true, deduplicate: false },
        input: Schema.Struct({ plan: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ plan }) => Effect.succeed({ text: `snapshot of the plan: ${plan}` }),
      }),
    }),
  ),
)
const toolsNode = makeLocationNode({ name: "test/context-tools", layer: tools, deps: [ToolRegistry.node] })

const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.succeed(
          SystemContext.make({
            key: systemContextKey,
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed("Initial context"),
            baseline: String,
            update: (_previous, current) => current,
          }),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))

const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

const configWith = (input?: { readonly payloadBytes?: number; readonly steps?: number }) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              agents: input?.steps === undefined ? undefined : { build: new ConfigAgent.Info({ steps: input.steps }) },
              context: new ConfigContext.Info({
                purge_errors: new ConfigContext.PurgeErrors({ turns: 1 }),
                protection: new ConfigContext.Protection({ recent_turns: 1 }),
                payload_bytes: input?.payloadBytes,
              }),
            }),
          }),
        ]),
    }),
  )

const config = configWith()

const runnerLayerWith = (config: Layer.Layer<Config.Service>) =>
  AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make(projectDir) })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
  ])

const executionWith = (config: Layer.Layer<Config.Service>) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayerWith(config)))

const harness = (config: Layer.Layer<Config.Service>) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        QuestionV2.node,
        SessionProjector.node,
        SessionStore.node,
        ApplicationTools.node,
        AgentV2.node,
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        toolsNode,
        ContextManager.node,
        CompressTool.node,
        SessionRunnerModel.node,
        SystemContextRegistry.node,
        SkillGuidance.node,
        ReferenceGuidance.node,
        Config.node,
        Snapshot.node,
        SessionRunnerLLM.node,
        SessionExecution.node,
        SessionV2.node,
      ]),
      [
        [LayerNodePlatform.llmClient, client],
        [PermissionV2.node, permission],
        [SessionRunnerModel.node, models],
        [SystemContextRegistry.node, systemContext],
        [Location.node, Location.boundNode({ directory: AbsolutePath.make(projectDir) })],
        [SkillGuidance.node, skillGuidance],
        [ReferenceGuidance.node, referenceGuidance],
        [Snapshot.node, Snapshot.noopLayer],
        [SessionExecution.node, executionWith(config)],
        [Config.node, config],
      ],
    ),
  )

const it = harness(config)
/** A ceiling small enough that a couple of file reads already blow past it. */
const itBounded = harness(configWith({ payloadBytes: 3_000 }))
/** One step per turn, so the very first provider request is already the max-steps request. */
const itLastStep = harness(configWith({ steps: 1 }))
/** A ceiling nothing can fit under, not even an empty conversation with its tools. */
const itUnfittable = harness(configWith({ payloadBytes: 200 }))

const sessionID = SessionV2.ID.make("ses_context_manager_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  requests.length = 0
  turns = []
  summary = "## State\n- implemented the authentication flow"
  summaryAvailable = true
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(projectDir), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: projectDir,
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return yield* SessionV2.Service
})

const ask = (session: SessionV2.Interface, text: string) =>
  session
    .prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
    .pipe(Effect.andThen(session.resume(sessionID)))

const agentTurns = () => requests.filter((request) => !isCompression(request))

/** Record every payload of one event definition for the remainder of the test. */
const collect = <D extends EventV2.Definition>(definition: D) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const received: EventV2.Data<D>[] = []
    yield* (events.subscribe(definition) as Stream.Stream<EventV2.Payload<D>>).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          received.push(event.data)
        }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return received
  })

const toolResults = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [JSON.stringify(part.result)] : []))
      : [],
  )

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

describe("ContextManager", () => {
  it.effect("assembles exactly one system prompt containing stable context guidance", () =>
    Effect.gen(function* () {
      const session = yield* setup
      turns = [say("First"), say("Second")]

      yield* ask(session, "Hello")
      yield* ask(session, "Again")

      for (const request of agentTurns()) {
        expect(request.system.map((part) => part.text)).toEqual([ContextManager.GUIDANCE, "Initial context"])
        // Context management never appends a chronological system message of its own.
        expect(request.messages.filter((message) => message.role === "system")).toHaveLength(0)
        expect(request.messages.every((message) => message.role !== "assistant" || message.content.length > 0)).toBe(
          true,
        )
      }
    }),
  )

  it.effect("prunes superseded duplicate tool output while keeping the canonical history intact", () =>
    Effect.gen(function* () {
      const session = yield* setup
      turns = [
        call("call-1", "inspect", { file: "src/index.ts" }),
        call("call-2", "inspect", { file: "src/index.ts" }),
        call("call-3", "inspect", { file: "src/index.ts" }),
        say("Done"),
      ]

      yield* ask(session, "Inspect the entry point")

      const last = agentTurns().at(-1)!
      const results = toolResults(last)
      expect(results).toHaveLength(3)
      expect(results[0]).toContain(ContextDeduplicate.MARKER)
      expect(results[1]).toContain(ContextDeduplicate.MARKER)
      expect(results[2]).toContain("contents of src/index.ts")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const outputs = history.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool" && part.state.status === "completed"
                ? part.state.content.map((item) => (item.type === "text" ? item.text : ""))
                : [],
            )
          : [],
      )
      expect(outputs).toEqual([fileBody("src/index.ts"), fileBody("src/index.ts"), fileBody("src/index.ts")])
    }),
  )

  it.effect("purges a stale failed tool input while keeping its diagnostic", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const script = "console.log('x')\n".repeat(500)
      turns = [call("call-fail", "generate", { script }), say("Recovering"), say("Done")]

      yield* ask(session, "Run the script")
      yield* ask(session, "Continue")

      const last = agentTurns().at(-1)!
      const inputs = last.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool-call" ? [JSON.stringify(part.input)] : []))
          : [],
      )
      expect(inputs).toEqual([JSON.stringify({ purged: ContextPurgeErrors.MARKER })])
      expect(JSON.stringify(last.messages)).not.toContain(script)
      expect(JSON.stringify(last.messages)).toContain("exit code 1: syntax error")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const recorded = history.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool" ? [part.state.input] : []))
          : [],
      )
      expect(recorded).toEqual([{ script }])
    }),
  )

  it.effect("compresses a completed range into a placeholder without rewriting history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      turns = [
        say("Explored"),
        say("Implemented"),
        call("call-compress", "compress", { focus: "the auth flow" }),
        say("Compressed"),
      ]

      yield* ask(session, "Explore the repository")
      yield* ask(session, "Implement authentication")
      yield* ask(session, "Compress what is finished")

      const compression = requests.find(isCompression)
      expect(compression).toBeDefined()
      // Internal calls are isolated: no tools, no context guidance, no session transform.
      expect(compression!.tools).toEqual([])
      expect(compression!.system).toEqual([])
      expect(JSON.stringify(compression!.messages)).toContain("Focus the summary on: the auth flow")

      const last = agentTurns().at(-1)!
      const placeholder = userTexts(last).find((text) => text.includes("<compressed-conversation-section>"))
      expect(placeholder).toBeDefined()
      expect(placeholder).toContain("implemented the authentication flow")
      expect(userTexts(last)).not.toContain("Explore the repository")
      expect(userTexts(last)).toContain("Compress what is finished")
      expect(last.system.map((part) => part.text)).toEqual([ContextManager.GUIDANCE, "Initial context"])
      expect(last.messages.filter((message) => message.role === "system")).toHaveLength(0)

      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(history.flatMap((message) => (message.type === "user" ? [message.text] : []))).toContain(
        "Explore the repository",
      )

      const { db } = yield* Database.Service
      const blocks = yield* db
        .select()
        .from(SessionContextBlockTable)
        .where(eq(SessionContextBlockTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]!.summary).toContain("implemented the authentication flow")
      expect(blocks[0]!.id.startsWith(ContextState.PREFIX)).toBe(true)

      const stats = yield* (yield* ContextManager.Service).stats(sessionID)
      expect(stats.compressionCount).toBe(1)
      expect(stats.tokensSaved).toBeGreaterThan(0)
    }),
  )

  it.effect("folds an earlier summary into an overlapping compression", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      turns = [say("One"), say("Two"), say("Three"), say("Four"), say("Five")]

      yield* ask(session, "Step one")
      yield* ask(session, "Step two")
      yield* ask(session, "Step three")
      yield* ask(session, "Step four")
      yield* ask(session, "Step five")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const inner = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[3]!.id,
      })
      if ("failure" in inner) throw new Error(`inner compression failed: ${inner.failure}`)

      summary = "## State\n- combined summary covering both ranges"
      const outer = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[5]!.id,
      })
      if ("failure" in outer) throw new Error(`outer compression failed: ${outer.failure}`)

      const prompt = requests.filter(isCompression).at(-1)!
      expect(JSON.stringify(prompt.messages)).toContain("implemented the authentication flow")
      expect(outer.block.nested).toContain(inner.block.id)

      const { db } = yield* Database.Service
      expect((yield* ContextState.list(db, sessionID)).map((block) => block.id)).toEqual([outer.block.id])

      turns = [say("After compression")]
      yield* ask(session, "Keep going")
      const last = agentTurns().at(-1)!
      const placeholder = userTexts(last).find((text) => text.includes("<compressed-conversation-section>"))
      expect(placeholder).toContain("combined summary covering both ranges")
      expect(userTexts(last).filter((text) => text.includes("<compressed-conversation-section>"))).toHaveLength(1)
    }),
  )

  it.effect("absorbs a partially overlapping summary instead of stranding it", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      turns = [say("One"), say("Two"), say("Three"), say("Four"), say("Five")]

      yield* ask(session, "Step one")
      yield* ask(session, "Step two")
      yield* ask(session, "Step three")
      yield* ask(session, "Step four")
      yield* ask(session, "Step five")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const first = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[2]!.id,
        endMessageID: history[5]!.id,
      })
      if ("failure" in first) throw new Error(`first compression failed: ${first.failure}`)

      summary = "## State\n- combined summary of the overlapping ranges"
      // Overlaps the first block on one side only: neither range contains the other.
      const second = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[3]!.id,
      })
      if ("failure" in second) throw new Error(`second compression failed: ${second.failure}`)

      // The range grew to swallow the block it overlapped, so no summary is left unreachable.
      expect(second.block.startMessageID).toBe(history[0]!.id)
      expect(second.block.endMessageID).toBe(history[5]!.id)
      expect(second.block.nested).toContain(first.block.id)

      const { db } = yield* Database.Service
      expect((yield* ContextState.list(db, sessionID)).map((block) => block.id)).toEqual([second.block.id])

      turns = [say("After compression")]
      yield* ask(session, "Keep going")
      const last = agentTurns().at(-1)!
      const placeholders = userTexts(last).filter((text) => text.includes("<compressed-conversation-section>"))
      expect(placeholders).toHaveLength(1)
      expect(placeholders[0]).toContain("combined summary of the overlapping ranges")
      expect(userTexts(last)).not.toContain("Step one")
    }),
  )

  itBounded.effect("compresses on the payload byte ceiling even when the token window is nearly empty", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failures = yield* collect(SessionEvent.Context.CompressionFailed)
      turns = [call("call-1", "inspect", { file: "src/index.ts" }), say("First"), say("Second"), say("Third")]

      yield* ask(session, "Inspect the entry point")
      yield* ask(session, "Keep going")
      yield* ask(session, "And again")

      const context = yield* ContextManager.Service
      const stats = yield* context.stats(sessionID)
      // The 200k token window is barely touched: only the byte ceiling can have forced this.
      expect(stats.utilization).toBeLessThan(0.6)
      expect(stats.compressionCount).toBeGreaterThan(0)
      expect(requests.some(isCompression)).toBe(true)
      expect(stats.tokensSaved).toBeGreaterThan(0)
      // A payload that the ladder still cannot fit is reported rather than silently oversized.
      expect(failures.map((event) => event.reason).join("|")).toContain("payload byte budget")
    }),
  )

  itUnfittable.effect("never sends a request that cannot be reduced under the payload ceiling", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failures = yield* collect(SessionEvent.Step.Failed)
      turns = [say("This turn must never reach the provider")]

      yield* ask(session, "Hello")

      // Nothing that carries tools is an agent turn, so an empty list here means the oversized
      // request was never handed to the client. The queued provider turn is still unconsumed.
      expect(requests.filter((request) => request.tools.length > 0)).toEqual([])
      expect(turns).toHaveLength(1)
      // The turn fails loudly instead of silently sending or silently stopping.
      expect(JSON.stringify(failures)).toContain("context payload budget")

      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(history.flatMap((message) => (message.type === "user" ? [message.text] : []))).toEqual(["Hello"])
    }),
  )

  it.effect("degrades gracefully when the summary model returns nothing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      const failures = yield* collect(SessionEvent.Context.CompressionFailed)
      turns = [say("One"), say("Two"), say("Three")]
      yield* ask(session, "Step one")
      yield* ask(session, "Step two")
      yield* ask(session, "Step three")

      summaryAvailable = false
      const history = yield* session.messages({ sessionID, order: "asc" })
      const result = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[1]!.id,
      })

      expect(result).toEqual({ failure: "summary-unavailable" })
      expect(failures).toHaveLength(1)

      turns = [say("Still usable")]
      yield* ask(session, "Continue anyway")
      expect(userTexts(agentTurns().at(-1)!)).toContain("Step one")
    }),
  )

  it.effect("refuses to compress the protected recent window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      turns = [say("One"), say("Two")]
      yield* ask(session, "Step one")
      yield* ask(session, "Step two")

      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(
        yield* context.compress({
          sessionID,
          reason: "manual",
          startMessageID: history[0]!.id,
          endMessageID: history.at(-1)!.id,
        }),
      ).toEqual({ failure: "protected-range" })
    }),
  )

  it.effect("reports prepared context statistics for the TUI", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const prepared = yield* collect(SessionEvent.Context.Prepared)
      turns = [call("call-1", "inspect", { file: "a.ts" }), call("call-2", "inspect", { file: "a.ts" }), say("Done")]

      yield* ask(session, "Inspect twice")

      expect(prepared.length).toBeGreaterThan(0)
      const last = prepared.at(-1)!
      expect(last.rawTokens).toBeGreaterThan(0)
      expect(last.preparedTokens).toBeLessThanOrEqual(last.rawTokens)
      expect(last.deduplicatedMessages).toBe(1)
      expect(last.limit).toBe(199_000)
      expect(last.recommendation).toBe("none")
    }),
  )

  it.effect("budgets the system prompt and tool definitions, not just the history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const prepared = yield* collect(SessionEvent.Context.Prepared)
      turns = [say("Done")]

      yield* ask(session, "Say something")

      const request = agentTurns().at(-1)!
      // Measured from the request objects themselves, not from a parallel description of them: the
      // runner hands the compiler the very arrays it then sends.
      const envelope = ContextBudget.envelope({ system: request.system, tools: request.tools, extra: [] })
      const last = prepared.at(-1)!
      // The measured overhead is the request's own system prompt and tool definitions, so a large
      // toolset can no longer hide from the utilization bands.
      expect(last.overheadTokens).toBe(envelope.tokens)
      expect(last.overheadTokens).toBeGreaterThan(0)
      expect(last.preparedTokens).toBeGreaterThan(last.overheadTokens)
      expect(last.utilization).toBeCloseTo(last.preparedTokens / 199_000, 10)
    }),
  )

  it.effect("budgets the max-steps message exactly as the request carries it", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // One step per turn, so the very first provider request is already the max-steps request.
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.defaultID, (info) => {
          info.steps = 1
        }),
      )
      const prepared = yield* collect(SessionEvent.Context.Prepared)
      turns = [say("Done")]

      yield* ask(session, "Say something")

      const request = agentTurns().at(-1)!
      const trailing = request.messages.at(-1)!
      // The runner appends the max-steps prompt as an assistant message rather than as request
      // metadata, so the compiler has to be told about it in that exact shape.
      expect(trailing).toEqual(Message.assistant(MAX_STEPS_PROMPT))
      expect(request.tools).toEqual([])
      const envelope = ContextBudget.envelope({
        system: request.system,
        tools: request.tools,
        extra: [trailing],
      })
      expect(prepared.at(-1)!.overheadTokens).toBe(envelope.tokens)
    }),
  )

  it.effect("keeps a protected tool call verbatim inside an explicitly compressed range", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      turns = [call("call-snap", "snapshot", { plan: "ship the parser" }), say("Recorded"), say("Two"), say("Three")]

      yield* ask(session, "Record the plan")
      yield* ask(session, "Step two")
      yield* ask(session, "Step three")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const snapshotMessage = history.find(
        (message) =>
          message.type === "assistant" &&
          message.content.some((part) => part.type === "tool" && part.name === "snapshot"),
      )!
      const end = history.findIndex((message) => message.id === snapshotMessage.id) + 2
      const result = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[end]!.id,
      })
      if ("failure" in result) throw new Error(`compression failed: ${result.failure}`)

      // The protected message inside the requested range is reported, not silently swallowed.
      expect(result.excludedMessages).toBe(1)
      expect(result.block.sourceMessageCount).toBe(end)

      turns = [say("Four")]
      yield* ask(session, "Step four")

      const last = agentTurns().at(-1)!
      expect(userTexts(last).some((text) => text.includes("<compressed-conversation-section>"))).toBe(true)
      expect(JSON.stringify(last.messages)).toContain("snapshot of the plan: ship the parser")
    }),
  )

  it.effect("keeps compression boundaries out of a natively compacted history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const context = yield* ContextManager.Service
      turns = [say("One"), say("Two"), say("Three")]
      yield* ask(session, "Step one")
      yield* ask(session, "Step two")
      yield* ask(session, "Step three")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const compressed = yield* context.compress({
        sessionID,
        reason: "manual",
        startMessageID: history[0]!.id,
        endMessageID: history[1]!.id,
      })
      if ("failure" in compressed) throw new Error(`compression failed: ${compressed.failure}`)

      yield* context.invalidate(sessionID)
      const { db } = yield* Database.Service
      expect(yield* ContextState.list(db, sessionID)).toEqual([])

      turns = [say("After compaction")]
      yield* ask(session, "Continue")
      expect(userTexts(agentTurns().at(-1)!)).toContain("Step one")
    }),
  )
})
