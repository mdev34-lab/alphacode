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
import { SessionContextReduction } from "@opencode-ai/core/session/context-reduction"
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
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

/**
 * End-to-end coverage of dynamic context reduction through the real runner and session path: a
 * prompt goes in, the runner loads canonical history, derives the context for one provider request
 * and sends it. Every assertion here is about what the model actually received, what the session
 * still records, and what the runtime published about the request — never about a helper in
 * isolation.
 *
 * The fixtures are sized against measured request weights, which the comment above each model
 * window states. A tool call with a 1_400-character output weighs about 900 tokens once the
 * envelope is included; the prompt envelope of this harness weighs 281.
 */

const projectDir = mkdtempSync(path.join(tmpdir(), "alphacode-context-reduction-"))

const requests: LLMRequest[] = []
let turns: LLMEvent[][] = []
const SUMMARY = "This is the compaction summary"

/** A compaction summary request is the isolated internal call: one user message and no tools. */
const isSummary = (request: LLMRequest) =>
  request.tools.length === 0 &&
  request.messages.length === 1 &&
  request.messages[0]?.role === "user" &&
  JSON.stringify(request.messages[0]?.content).includes("anchored summary")

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      // The summary call is served out of band: it lands between two agent requests, so a scripted
      // queue would hand its turn to the summarizer and desynchronize the conversation.
      if (isSummary(request)) return Stream.fromIterable(say(SUMMARY))
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

/** A model whose usable window is `context` minus the output it reserves. */
const window = (context: number, output = 250) =>
  Model.make({
    id: `fake-${context}`,
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context, output } }),
  })

/** Room enough that nothing is ever under pressure. */
const roomy = window(200_000, 1_000)
/** Room enough for compaction to summarize a history that is already over the reduction target. */
const compactable = window(25_000, 1_000)
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

/** One line of a file body, repeated to size a tool output exactly. */
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
      generate: Tool.make({
        description: "Run a generated script",
        input: Schema.Struct({ script: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: () => Effect.fail(new Tool.Failure({ message: "exit code 1: syntax error" })),
      }),
      snapshot: Tool.make({
        description: "Record the current plan",
        // Declared protected by the tool itself, exactly like todowrite in the real registry.
        contextPolicy: { protect: true, deduplicate: false },
        input: Schema.Struct({ plan: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ plan }) => Effect.succeed({ text: `snapshot of the plan: ${plan}` }),
      }),
    }),
  ),
)
const toolsNode = makeLocationNode({ name: "test/context-reduction-tools", layer: tools, deps: [ToolRegistry.node] })

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

/**
 * Compaction is off unless a test asks for it: reduction is the mechanism under test, and native
 * compaction would otherwise rewrite the history out from under every assertion.
 */
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

const runnerLayerWith = (config: Layer.Layer<Config.Service>, systemContext: Layer.Layer<never>) =>
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

const executionWith = (config: Layer.Layer<Config.Service>, systemContext: Layer.Layer<never>) =>
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
  ).pipe(Layer.provide(runnerLayerWith(config, systemContext)))

const harness = (config: Layer.Layer<Config.Service>, baseline = "Initial context") => {
  const systemContext = systemContextWith(baseline)
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
        [SessionExecution.node, executionWith(config, systemContext)],
        [Config.node, config],
      ],
    ),
  )
}

/** One protected recent turn, so stale content is reachable without a long conversation. */
const narrow = new ConfigContext.Info({
  reduction: new ConfigContext.Reduction({ error_turns: 1 }),
  protection: new ConfigContext.Protection({ recent_turns: 1 }),
})

const it = harness(configWith())
const itNarrow = harness(configWith({ context: narrow }))
/** Reduction switched off: the pipeline has to be a passthrough even under real pressure. */
const itDisabled = harness(
  configWith({ context: new ConfigContext.Info({ reduction: new ConfigContext.Reduction({ enabled: false }) }) }),
)
/** A system prompt large enough to put a nearly empty history over the reduction target. */
const itEnvelope = harness(
  configWith({ context: new ConfigContext.Info({ protection: new ConfigContext.Protection({ recent_turns: 1 }) }) }),
  `initial context padding ${"x".repeat(6_000)}`,
)
/**
 * A protection window covering the whole conversation, so nothing is eligible and reduction has to
 * report that instead of pruning protected content — with compaction armed as the escalation.
 */
const itProtected = harness(
  configWith({
    context: new ConfigContext.Info({
      reduction: new ConfigContext.Reduction({ threshold: 0.2 }),
      protection: new ConfigContext.Protection({ recent_turns: 50 }),
    }),
    compaction: new ConfigCompaction.Info({ auto: true, keep: new ConfigCompaction.Keep({ tokens: 100 }) }),
  }),
)

const sessionID = SessionV2.ID.make("ses_context_reduction_test")

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
  session
    .prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
    .pipe(Effect.andThen(session.resume(sessionID)))

/** Every request the runner sent to the model for the conversation, in order. */
const sent = () => requests.filter((request) => !isSummary(request))

/** Record every payload of one event definition for the remainder of the test. */
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

const toolResults = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [JSON.stringify(part.result)] : []))
      : [],
  )

const toolInputs = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "tool-call" ? [JSON.stringify(part.input)] : []))
      : [],
  )

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const markers = (request: LLMRequest, marker: string) =>
  toolResults(request).filter((result) => result.includes(marker)).length

/** Every recorded tool output in canonical history, in order. */
const recordedOutputs = (history: readonly SessionMessage.Message[]) =>
  history.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "tool" && part.state.status === "completed"
            ? part.state.content.map((item) => (item.type === "text" ? item.text : ""))
            : [],
        )
      : [],
  )

describe("dynamic context reduction", () => {
  it.effect("sends canonical history untouched while the request fits the window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [call("call-1", "inspect", { file: "src/index.ts" }), say("Done")]

      yield* ask(session, "Inspect the entry point")

      const request = sent().at(-1)!
      expect(toolResults(request).at(-1)).toContain("contents of src/index.ts")
      expect(JSON.stringify(request.messages)).not.toContain(SessionContextReduction.DUPLICATE_MARKER)
      // One report per provider request, describing the request that was actually sent.
      expect(reports).toHaveLength(sent().length)
      expect(reports.at(-1)).toMatchObject({ outcome: "untouched", reclaimedTokens: 0, limit: 199_000 })
      expect(reports.at(-1)!.utilization).toBeCloseTo(reports.at(-1)!.tokens / 199_000, 10)
      expect(reports.at(-1)!.overheadTokens).toBeGreaterThan(0)
      expect(reports.at(-1)!.tokens).toBeGreaterThan(reports.at(-1)!.overheadTokens)
    }),
  )

  itNarrow.effect("reduces the request under pressure without touching canonical history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Three identical reads weigh 3_015 tokens together; pruning the two superseded outputs
      // brings the request to about 1_520, so a 2_500-token window targets 2_000: over before
      // reduction, under after it.
      currentModel = window(2_750)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-1", "inspect", { file: "src/index.ts", lines: 60 }),
        call("call-2", "inspect", { file: "src/index.ts", lines: 60 }),
        call("call-3", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Done"),
      ]

      yield* ask(session, "Inspect the entry point")

      const request = sent().at(-1)!
      // Three identical reads are one fact: only the newest keeps its output.
      expect(markers(request, SessionContextReduction.DUPLICATE_MARKER)).toBe(2)
      expect(toolResults(request).at(-1)).toContain("contents of src/index.ts")
      expect(reports.at(-1)!.outcome).toBe("reduced")
      expect(reports.at(-1)!.reclaimedTokens).toBeGreaterThan(0)
      expect(reports.at(-1)!.tokens).toBeLessThanOrEqual(2_500 * 0.8)

      // The session stays authoritative and immutable: reduction is a projection of it.
      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(recordedOutputs(history)).toEqual([
        body("src/index.ts", 60),
        body("src/index.ts", 60),
        body("src/index.ts", 60),
      ])
    }),
  )

  itNarrow.effect("purges a stale failed tool input and keeps its diagnostic", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const script = "console.log('x')\n".repeat(120)
      // The failed call weighs about 720 tokens, its input about 570 of them: a 2_200-token window
      // targets 1_760, which the request exceeds until the input is purged.
      currentModel = window(2_400, 200)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-fail", "generate", { script }),
        say("Recovering"),
        call("call-read", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Done"),
      ]

      yield* ask(session, "Run the script")
      yield* ask(session, "Continue")

      const request = sent().at(-1)!
      expect(toolInputs(request)).toContain(JSON.stringify({ purged: SessionContextReduction.PURGED_INPUT_MARKER }))
      expect(JSON.stringify(request.messages)).not.toContain("console.log")
      // The failure itself is the useful part and survives its input.
      expect(JSON.stringify(request.messages)).toContain("exit code 1: syntax error")
      expect(reports.at(-1)!.outcome).toBe("reduced")

      const history = yield* session.messages({ sessionID, order: "asc" })
      const inputs = history.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool" && part.state.status === "error" ? [part.state.input] : [],
            )
          : [],
      )
      expect(inputs).toEqual([{ script }])
    }),
  )

  itNarrow.effect("truncates an oversized stale output instead of dropping the call", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // The stale read weighs about 2_900 tokens and about 2_150 of them are the middle of its
      // output, so a 1_875-token window targets 1_500: over until the output keeps its two ends.
      currentModel = window(2_125)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-big", "inspect", { file: "src/large.ts", lines: 200 }),
        say("Noted"),
        call("call-next", "inspect", { file: "src/other.ts", lines: 10 }),
        say("Done"),
      ]

      yield* ask(session, "Read the large file")
      yield* ask(session, "Read the next one")

      const request = sent().at(-1)!
      const truncated = toolResults(request).find((result) => result.includes(SessionContextReduction.TRUNCATED_MARKER))
      expect(truncated).toBeDefined()
      // The call and both ends of its output survive; only the middle is gone.
      expect(truncated).toContain("contents of src/large.ts")
      expect(truncated!.length).toBeLessThan(body("src/large.ts", 200).length)
      expect(reports.at(-1)!.outcome).toBe("reduced")

      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(recordedOutputs(history)).toContain(body("src/large.ts", 200))
    }),
  )

  itNarrow.effect("drops the oldest turns last and never the protected recent window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Four 900-character prompts weigh 1_571 tokens and each oldest turn is worth about 255 of
      // them, so a 1_375-token window targets 1_100: the two oldest prompts and the first answer
      // have to go, and the protected recent window cannot.
      currentModel = window(1_625)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [say("First"), say("Second"), say("Third"), say("Fourth")]

      yield* ask(session, `oldest ${"a".repeat(900)}`)
      yield* ask(session, `older ${"b".repeat(900)}`)
      yield* ask(session, `newer ${"c".repeat(900)}`)
      yield* ask(session, `newest ${"d".repeat(900)}`)

      const request = sent().at(-1)!
      const texts = userTexts(request)
      expect(texts.some((text) => text.startsWith("oldest"))).toBe(false)
      expect(texts.some((text) => text.startsWith("older"))).toBe(false)
      // The question being answered, the turn that answered it, and the newest prompt all stay.
      expect(texts.some((text) => text.startsWith("newer"))).toBe(true)
      expect(texts.some((text) => text.startsWith("newest"))).toBe(true)
      expect(JSON.stringify(request.messages)).toContain("Third")
      expect(reports.at(-1)!.outcome).toBe("reduced")
      expect(reports.at(-1)!.tokens).toBeLessThanOrEqual(1_375 * 0.8)

      // Dropping is a projection too: every prompt is still in the session.
      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(history.filter((message) => message.type === "user")).toHaveLength(4)
    }),
  )

  itNarrow.effect("keeps a tool-declared protected call verbatim under pressure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // The plan and two identical reads weigh 2_308 tokens; deduplicating the reads brings it to
      // about 1_560, so a 2_250-token window targets 1_800 and the plan never becomes eligible.
      currentModel = window(2_500)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-plan", "snapshot", { plan: "refactor the auth module" }),
        call("call-1", "inspect", { file: "src/index.ts", lines: 60 }),
        call("call-2", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Done"),
      ]

      yield* ask(session, "Record the plan and inspect")

      const request = sent().at(-1)!
      expect(JSON.stringify(request.messages)).toContain("snapshot of the plan: refactor the auth module")
      expect(markers(request, SessionContextReduction.DUPLICATE_MARKER)).toBe(1)
      expect(reports.at(-1)!.outcome).toBe("reduced")
    }),
  )

  itEnvelope.effect("budgets the prompt envelope, not just the history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // The system prompt alone weighs about 1_780 tokens here, so a 1_750-token window targets
      // 1_400 and the request is over budget before a single tool call is made.
      currentModel = window(2_000)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-1", "inspect", { file: "src/index.ts", lines: 40 }),
        call("call-2", "inspect", { file: "src/index.ts", lines: 40 }),
        say("Done"),
      ]

      yield* ask(session, "Inspect")

      const report = reports.at(-1)!
      const target = 1_750 * 0.8
      expect(
        sent()
          .at(-1)!
          .system.map((part) => part.text)[0],
      ).toContain("initial context padding")
      // The history on its own is nowhere near the target; the envelope is what put the request
      // over it. Measuring history alone would have seen no pressure and sent both copies of the
      // same read.
      expect(report.tokens - report.overheadTokens).toBeLessThan(target)
      expect(report.tokens).toBeGreaterThan(target)
      expect(report.overheadTokens).toBeGreaterThan(report.tokens / 2)
      // Reduction ran and gave everything it was allowed to, but the envelope is not reducible:
      // the honest report is that the request could not be brought under its target.
      expect(report.outcome).toBe("exhausted")
      expect(report.reclaimedTokens).toBeGreaterThan(0)
    }),
  )

  itNarrow.effect("stays reduced across turns instead of resetting", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Two identical reads across three turns weigh 2_239 and then 2_368 tokens; pruning the
      // superseded output brings them to about 1_490 and 1_620, so a 2_375-token window targets
      // 1_900: both turns reduce, and neither has to drop a message to do it.
      currentModel = window(2_625)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-1", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Read it"),
        call("call-2", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Read it again"),
        say("Done"),
      ]

      yield* ask(session, "Inspect the entry point")
      yield* ask(session, "Inspect it once more")
      const previous = sent().at(-1)!
      yield* ask(session, "Summarize what you found")
      const next = sent().at(-1)!

      // The next turn re-derives its context from the same history and reaches the same decision:
      // reduction is not per-turn state that a new turn could lose or repeat from scratch.
      expect(reports.at(0)!.outcome).toBe("untouched")
      expect(reports.at(-2)!.outcome).toBe("reduced")
      expect(reports.at(-1)!.outcome).toBe("reduced")
      expect(reports.at(-1)!.reclaimedTokens).toBeGreaterThanOrEqual(reports.at(-2)!.reclaimedTokens)
      // What was already reduced stays reduced, so the whole previous request is still the prefix
      // of the next one — the property provider prompt caching depends on.
      expect(markers(next, SessionContextReduction.DUPLICATE_MARKER)).toBe(1)
      expect(JSON.stringify(next.messages.slice(0, previous.messages.length))).toBe(JSON.stringify(previous.messages))
      expect(reports).toHaveLength(sent().length)

      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(recordedOutputs(history)).toEqual([body("src/index.ts", 60), body("src/index.ts", 60)])
    }),
  )

  itDisabled.effect("passes canonical history through when reduction is disabled", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Deliberately the window from the deduplication test: the pressure is real, and disabling
      // reduction has to leave the request alone anyway.
      currentModel = window(2_000)
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        call("call-1", "inspect", { file: "src/index.ts", lines: 60 }),
        call("call-2", "inspect", { file: "src/index.ts", lines: 60 }),
        say("Done"),
      ]

      yield* ask(session, "Inspect the entry point")

      const request = sent().at(-1)!
      expect(JSON.stringify(request.messages)).not.toContain(SessionContextReduction.DUPLICATE_MARKER)
      expect(toolResults(request).filter((result) => result.includes("contents of src/index.ts"))).toHaveLength(2)
      expect(reports.at(-1)).toMatchObject({ outcome: "untouched", reclaimedTokens: 0 })
      expect(reports.at(-1)!.tokens).toBeGreaterThan(1_750 * 0.8)
    }),
  )

  itProtected.effect("reports exhausted and escalates to compaction when everything is protected", () =>
    Effect.gen(function* () {
      const session = yield* setup
      // Fifteen distinct reads weigh about 9_300 tokens, over both the 0.2 threshold of a 24_000
      // token window and the compaction trigger — and every one of them is inside the protected
      // window, so reduction has nothing it is allowed to take.
      currentModel = compactable
      const reports = yield* collect(SessionEvent.Context.Prepared)
      turns = [
        ...Array.from({ length: 15 }, (_, index) =>
          call(`call-${index}`, "inspect", { file: `src/file-${index}.ts`, lines: 60 }),
        ),
        say("Done"),
      ]

      yield* ask(session, "Read every file")

      // Reduction gave everything it was allowed to give and said so rather than pruning protected
      // content, and the runtime escalated to the durable summarization it already owns.
      expect(reports.map((report) => report.outcome)).toContain("exhausted")
      expect(requests.some(isSummary)).toBe(true)
      const history = yield* session.messages({ sessionID, order: "asc" })
      expect(history.some((message) => message.type === "compaction")).toBe(true)
      // The turn after compaction is coherent: it carries the checkpoint, not the dropped history.
      expect(userTexts(sent().at(-1)!).join("\n")).toContain(SUMMARY)
      expect(reports).toHaveLength(sent().length)
    }),
  )
})
