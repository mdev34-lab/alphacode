import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { ConfigContext } from "@opencode-ai/core/config/context"
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
import { SessionContextPressure } from "@opencode-ai/core/session/context-pressure"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
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
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

/**
 * End-to-end coverage of agent-driven compression and the pressure nudge through the real runner
 * and session path. Reduction stays a silent projection; compression is the durable counterpart the
 * agent invokes, and the pressure source is how the runtime tells the agent it exists.
 */

const projectDir = mkdtempSync(path.join(tmpdir(), "alphacode-context-compress-"))

const requests: LLMRequest[] = []
let turns: LLMEvent[][] = []
const COMPRESS_SUMMARY = "Earlier work finished the auth refactor and recorded the failing test."

const isCompressSummary = (request: LLMRequest) =>
  request.tools.length === 0 &&
  request.messages.length === 1 &&
  request.messages[0]?.role === "user" &&
  JSON.stringify(request.messages[0]?.content).includes("You are compressing a completed section")

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      // The summarization call is served out of band: it lands inside a tool settlement, so a
      // scripted queue would hand its turn to the summarizer and desynchronize the conversation.
      if (isCompressSummary(request)) return Stream.fromIterable(say(COMPRESS_SUMMARY))
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

const window = (context: number, output = 250) =>
  Model.make({
    id: `fake-${context}`,
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context, output } }),
  })

const roomy = window(200_000, 1_000)
let currentModel = roomy
const models = SessionRunnerModel.layerWith(() => Effect.succeed(currentModel))

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

const body = (file: string, lines: number) => `contents of ${file}\n${"export const value = 1\n".repeat(lines)}`

const tools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      inspect: Tool.make({
        description: "Read a file",
        input: Schema.Struct({ file: Schema.String, lines: Schema.optional(Schema.Number) }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ file, lines }) => Effect.succeed({ text: body(file, lines ?? 40) }),
      }),
    }),
  ),
)
const toolsNode = makeLocationNode({ name: "test/compress-tools", layer: tools, deps: [ToolRegistry.node] })

const systemContextKey = SystemContext.Key.make("test/context")
const systemContextWith = (baseline: string) =>
  Layer.effectDiscard(
    SystemContextRegistry.Service.pipe(
      Effect.flatMap((registry) =>
        registry.register({
          key: systemContextKey,
          load: Effect.succeed(
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed(baseline),
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
// Compression tests isolate the durable write; the nudge has its own harness below and would
// otherwise add system updates to every pressured turn here.
const mutedPressure = Layer.mock(SessionContextPressure.Service, {
  record: () => Effect.void,
  load: () => Effect.succeed(SystemContext.empty),
})

const configWith = (input?: { readonly context?: ConfigContext.Info; readonly compaction?: ConfigCompaction.Info }) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: input?.compaction ?? new ConfigCompaction.Info({ auto: false }),
              context: input?.context,
            }),
          }),
        ]),
    }),
  )

const harness = (
  config: Layer.Layer<Config.Service>,
  pressure: Layer.Layer<SessionContextPressure.Service> | undefined,
  baseline = "Initial context",
) => {
  const systemContext = systemContextWith(baseline)
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make(projectDir) })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    ...(pressure ? [[SessionContextPressure.node, pressure] as const] : []),
    [PermissionV2.node, permission],
    [Config.node, config],
  ])
  const execution = Layer.effect(
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
  ).pipe(Layer.provide(runnerLayer))
  return testEffect(
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
        CompressTool.node,
        SessionRunnerModel.node,
        SystemContextRegistry.node,
        SkillGuidance.node,
        ReferenceGuidance.node,
        SessionContextPressure.node,
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
        ...(pressure ? [[SessionContextPressure.node, pressure] as const] : []),
        [Snapshot.node, Snapshot.noopLayer],
        [SessionExecution.node, execution],
        [Config.node, config],
      ],
    ),
  )
}

/** One protected recent turn, so finished work is reachable without a long conversation. */
const narrow = new ConfigContext.Info({
  protection: new ConfigContext.Protection({ recent_turns: 1 }),
})

const itCompress = harness(configWith({ context: narrow }), mutedPressure)
const itPressure = harness(configWith({ context: narrow }), undefined)

const sessionID = SessionV2.ID.make("ses_context_compress_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  requests.length = 0
  turns = []
  currentModel = roomy
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
  session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false }).pipe(Effect.andThen(session.resume(sessionID)))

const sent = () => requests.filter((request) => !isCompressSummary(request))

const collect = <D extends EventV2.Definition>(definition: D) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const received: EventV2.Data<D>[] = []
    yield* events.subscribe(definition).pipe(
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

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const systemTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "system"
      ? typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

describe("agent-driven compression", () => {
  itCompress.effect("writes a durable summary and prunes the summarized range", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const committed = yield* collect(SessionEvent.Compress.Committed)
      turns = [
        call("call-1", "inspect", { file: "src/auth.ts", lines: 60 }),
        say("Auth explored"),
        call("call-2", "inspect", { file: "src/other.ts", lines: 10 }),
        say("Other noted"),
        call("call-compress", "compress", { focus: "the auth refactor decisions and the failing test" }),
        say("Compressed"),
      ]

      yield* ask(session, "Explore auth")
      yield* ask(session, "Note the other file")
      const before = yield* session.messages({ sessionID, order: "asc" })

      yield* ask(session, "Compress the finished auth work")

      expect(committed).toHaveLength(1)
      expect(committed[0]!.sourceMessageCount).toBeGreaterThanOrEqual(2)
      // The summary carries the summarizer output and names the range it replaces.
      expect(committed[0]!.text).toContain(COMPRESS_SUMMARY)
      expect(committed[0]!.text).toContain("historical context")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const summaries = history.filter((message) => message.type === "synthetic")
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.text).toContain(COMPRESS_SUMMARY)
      // The originals are gone from canonical history; the in-progress compress request stays.
      const users = history.filter((message) => message.type === "user")
      expect(users).toHaveLength(1)
      expect(users[0]!.text).toContain("Compress the finished")
      expect(history.length).toBeLessThan(before.length)
      for (const pruned of committed[0]!.prunedMessageIDs) {
        expect(history.some((message) => message.id === pruned)).toBe(false)
      }

      // The next request carries the summary instead of the pruned exploration.
      const request = sent().at(-1)!
      expect(userTexts(request).join("\n")).toContain(COMPRESS_SUMMARY)
      expect(JSON.stringify(request.messages)).not.toContain("contents of src/auth.ts")
    }),
  )

  itCompress.effect("refuses a range that overlaps the protected recent window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const committed = yield* collect(SessionEvent.Compress.Committed)
      // A huge keep window covers the whole history, so there is no compressible region.
      turns = [say("First"), call("call-compress", "compress", { keep_recent_turns: 100 }), say("Done")]

      yield* ask(session, "Say hello")
      yield* ask(session, "Compress the recent turn")

      // Nothing was pruned: the recent window is not compressible.
      expect(committed).toHaveLength(0)
      const after = yield* session.messages({ sessionID, order: "asc" })
      expect(after.filter((message) => message.type === "synthetic")).toHaveLength(0)
      const compressCalls = after.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool" && part.name === "compress" && part.state.status === "completed"
                ? [part.state.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")]
                : [],
            )
          : [],
      )
      expect(compressCalls).toHaveLength(1)
      expect(compressCalls[0]).toContain("recent turns")
    }),
  )

  itCompress.effect("folds an earlier summary into a later compression", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const committed = yield* collect(SessionEvent.Compress.Committed)
      turns = [
        call("call-1", "inspect", { file: "src/first.ts", lines: 60 }),
        say("First explored"),
        call("call-2", "inspect", { file: "src/second.ts", lines: 10 }),
        say("Second noted"),
        call("call-compress-1", "compress", { focus: "first work" }),
        say("Compressed once"),
        call("call-3", "inspect", { file: "src/third.ts", lines: 10 }),
        say("Third noted"),
        call("call-compress-2", "compress", { focus: "everything so far" }),
        say("Compressed twice"),
      ]

      yield* ask(session, "Explore first")
      yield* ask(session, "Note second")
      yield* ask(session, "Compress the first work")
      yield* ask(session, "Note third")
      yield* ask(session, "Compress everything")

      expect(committed).toHaveLength(2)
      const history = yield* session.messages({ sessionID, order: "asc" })
      const summaries = history.filter((message) => message.type === "synthetic")
      // The first summary was old enough to be pruned by the second compression, which folded it.
      expect(summaries).toHaveLength(1)
      expect(committed[1]!.prunedMessageIDs).toContain(committed[0]!.messageID)
    }),
  )
})

describe("context pressure", () => {
  itPressure.effect("reaches the agent as system context after a pressured turn", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Two identical reads weigh about 2_100 tokens together; pruning one brings the request to
      // about 1_300, so a 2_000-token window targets 1_600: over before reduction, under after it.
      currentModel = window(3_000)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-1", "inspect", { file: "src/index.ts", lines: 60 }),
        call("call-2", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Done"),
        say("Next"),
      ]

      yield* ask(session, "Inspect twice")
      expect(reports.at(-1)!.outcome).toBe("reduced")

      yield* ask(session, "Continue")
      const request = sent().at(-1)!
      const pressure = [...systemTexts(request), ...userTexts(request)].join("\n")
      expect(pressure).toContain("Context pressure")
      expect(pressure).toContain("reduced")
      expect(pressure).toContain("compress tool")
    }),
  )

  itPressure.effect("stays silent while the request fits the window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [call("call-1", "inspect", { file: "src/index.ts" }), say("Done"), say("Next")]

      yield* ask(session, "Inspect once")
      expect(reports.at(-1)!.outcome).toBe("untouched")

      yield* ask(session, "Continue")
      const request = sent().at(-1)!
      const pressure = [...systemTexts(request), ...userTexts(request)].join("\n")
      expect(pressure).not.toContain("Context pressure")
    }),
  )
})
