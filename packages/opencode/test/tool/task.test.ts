import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import type { Reason } from "../../src/tool/finish"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}, extra: LayerNode.Replacement[] = []) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)], ...extra],
  )

const it = testEffect(layer())

// A parent whose session row reads but whose message history does not - the
// state a deleted or half-migrated parent presents. Routing a `review` request
// has to read that history, because a default session pins no agent.
//
// `Layer.mock` supplies only what the routing step reaches, so every later call
// - `create`, the permission prompt, the child run - dies with an
// `UnimplementedError`. That is what turns "the dispatch stopped at the routing
// step" into an assertion rather than a hope: if the swallow came back, the
// generic reviewer would resolve and the tool would run on into `create`.
const unreadableParent = Layer.mock(Session.Service)({
  get: (id: SessionID) =>
    Effect.succeed({
      id,
      slug: "unreadable",
      projectID: ProjectV2.ID.make("prj_unreadable"),
      directory: "/tmp",
      title: "Unreadable",
      version: "0.0.0-test",
      time: { created: Date.now(), updated: Date.now() },
    } satisfies Session.Info),
  messages: () => Effect.fail(new NotFoundError({ message: "Session not found" })),
})

const itUnreadableParent = testEffect(layer({}, [[Session.node, unreadableParent]]))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "work",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "work",
    agent: "work",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function replyParts(input: SessionPrompt.PromptInput, texts: string[]): SessionV1.WithParts {
  const replied = reply(input, texts[0] ?? "")
  return {
    ...replied,
    parts: texts.map((text) => ({
      id: PartID.ascending(),
      messageID: replied.info.id,
      sessionID: input.sessionID,
      type: "text" as const,
      text,
    })),
  }
}

const REVIEW_REPORT = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "The loop skips the first cache entry.",
  findings: [
    {
      severity: "important",
      title: "Off-by-one skips the first entry",
      file: "src/cache.ts",
      line: 42,
      detail: "Start at 0.",
    },
  ],
}

const reviewEnvelope = (report: Record<string, unknown> = REVIEW_REPORT) =>
  ["<alphacode-review>", JSON.stringify(report, null, 2), "</alphacode-review>"].join("\n")

const REVIEW_ANALYSIS = "### Assessment\n\n**Ready to proceed?** Needs fixes"

function reviewOps(chunks: string[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.sync(() => replyParts(input, chunks)),
  }
}

function reviewRunOps(chunks: string[], summary = "done"): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = replyParts(input, chunks)
        const now = Date.now()
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, finish] }
      }),
  }
}

/**
 * Scripts a child run that ends through a completed finish call declaring
 * `reason`, which is the only place the parent-facing termination is read from.
 */
/**
 * Scripts a review child that both delivers the canonical envelope and leaves
 * file writes behind. A reviewer sitting at the depth limit cannot review its
 * own writes, so its ending is an unreviewed handoff to the parent.
 */
function reviewWriteOps(chunks: string[], summary = "done"): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = replyParts(input, chunks)
        const now = Date.now()
        const write: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "edit",
          callID: "edit-call",
          state: {
            status: "completed",
            input: { filePath: "src/cache.ts" },
            output: "edited",
            title: "edit",
            metadata: { reviewLoop: { writesFiles: true } },
            time: { start: now, end: now },
          },
        }
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, write, finish] }
      }),
  }
}

function finishRunOps(reason: Reason, text: string, summary = text): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const replied = reply(input, text)
        const now = Date.now()
        const finish: SessionV1.ToolPart = {
          id: PartID.ascending(),
          messageID: replied.info.id,
          sessionID: input.sessionID,
          type: "tool",
          tool: "finish",
          callID: "finish-call",
          state: {
            status: "completed",
            input: { reason, result: summary },
            output: summary,
            title: "finish",
            metadata: {},
            time: { start: now, end: now },
          },
        }
        return { ...replied, parts: [...replied.parts, finish] }
      }),
  }
}

/** The termination element the parent reads out of a `<task>` envelope. */
function terminationOf(envelope: string) {
  return envelope.match(/<termination reason="[a-z_]+">.*<\/termination>/)?.[0]
}

describe("tool.task", () => {
  // The routing decision is made from the parent session, and an unreadable
  // parent used to read as "no parent agent" - which resolved a `review` request
  // to the generic reviewer and ran it with the generic prompt and the generic
  // permissions, with nothing in the transcript to say the routing had never
  // happened. A missing parent is a broken session, not a routing decision, so
  // it must fail the dispatch.
  //
  // The child agent is not available as a fallback: on the subtask path
  // `ctx.agent` is the child's own agent, so resolving by it would pick a
  // reviewer by the child's identity.
  itUnreadableParent.instance(
    "a review request against an unreadable parent fails",
    () =>
      Effect.gen(function* () {
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let asked = 0

        const exit = yield* Effect.exit(
          def.execute(
            {
              description: "review the cache fix",
              prompt: "look into the cache key path",
              subagent_type: "review",
              background: false,
            },
            {
              sessionID: SessionID.make("ses_unreadable_parent"),
              messageID: MessageID.ascending(),
              agent: "work-review",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () =>
                Effect.sync(() => {
                  asked++
                }),
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.pretty(exit.cause)
        expect(error).toContain("Cannot resolve which reviewer to dispatch")
        expect(error).toContain("ses_unreadable_parent")
        // The failure is raised before anything is dispatched, so the user is not
        // asked to authorise a review that is never going to run.
        expect(asked).toBe(0)
      }),
    30_000,
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("work")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("rejects primary agent targets at the execution seam", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      for (const subagent_type of ["work", "plan"]) {
        let asked = 0
        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () =>
                Effect.sync(() => {
                  asked++
                  throw new Error("permission prompt should not run for primary targets")
                }),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toBe(0)
        if (!Exit.isFailure(exit)) continue
        expect(Cause.pretty(exit.cause)).toContain(`Agent type ${subagent_type} is a primary agent`)
      }
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("runs background tasks without requiring an experimental flag", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  // The parent has no way to end its turn while a background child runs unless
  // it is told which finish reason yields instead of terminating. The launch
  // result is where that instruction has to land, because it is the only text
  // the model reads back from the call that started the child.
  it.instance("background launch tells the parent how to yield while the child runs", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="running"')
      expect(result.output).toContain('call finish with reason "waiting_for_subagent"')
      // Scoped to a parent that has not finished: delivering a completed result
      // while a background task keeps running is still the normal ending, and
      // nothing may read the new reason as the only way out.
      expect(result.output).toContain('If your own task is complete, call finish with reason "success" as usual')
      expect(result.output).toContain("does not hold your result back")
      // Scoped to the main session: the wait is refused for a session that is
      // itself a subagent, so the instruction must not send one to try it.
      expect(result.output).toContain("the main session can call finish")
      expect(result.output).toContain("A subagent cannot yield this way")
      expect(result.output).toContain('it must deliver with "success" or "failure" instead')
    }),
  )

  const runReview = (promptOps: TaskPromptOps) =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      return yield* def.execute(
        {
          description: "review cache fix",
          prompt: "review the cache fix",
          subagent_type: "review",
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    })

  it.instance("delivers the review report envelope as the canonical result", () =>
    Effect.gen(function* () {
      const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`]))

      expect(result.output).toContain(REVIEW_ANALYSIS)
      expect(result.output).toContain("<alphacode-review>")
      expect(result.output).toContain('"needs-fixes"')
      // Exactly one canonical envelope is persisted.
      expect(result.output.match(/<alphacode-review>/g)).toHaveLength(1)
      // The report is associated with the reviewed revision and the child
      // session so the parent knows which work unit was reviewed.
      expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
      expect(result.metadata.review.revision).toBe("uncommitted")
      expect(result.metadata.review.sessionId).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("a review child that hands off unreviewed writes keeps its canonical report", () =>
    Effect.gen(function* () {
      const result = yield* runReview(reviewWriteOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`]))

      // The canonical envelope is still the delivery.
      expect(result.output).toContain("<alphacode-review>")
      expect(result.output.match(/<alphacode-review>/g)).toHaveLength(1)
      // The handoff is declared, and it never reads as an approval.
      expect(result.metadata.review.verdict).toBe("pending")
      expect(result.metadata.review.termination).toBe("review-pending")
      expect(result.metadata.reviewLoop).toEqual({
        writesFiles: true,
        handoff: "pending",
        sessionId: result.metadata.sessionId,
      })
      expect(result.output).toContain("UNREVIEWED")
      // The report the parent paid for survives that handoff, and so does what
      // it was about: the reviewed revision and the child that produced it.
      expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
      expect(result.metadata.review.revision).toBe("uncommitted")
      expect(result.metadata.review.sessionId).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("a trailing empty text part does not erase the review report", () =>
    Effect.gen(function* () {
      const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`, "", "   \n"]))

      expect(result.output).toContain("<alphacode-review>")
      expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
      expect(result.output).toContain(REVIEW_ANALYSIS)
    }),
  )

  it.instance("a review report before the final text part is still delivered", () =>
    Effect.gen(function* () {
      const result = yield* runReview(reviewRunOps([reviewEnvelope(), "Closing observations after the report."]))

      expect(result.output).toContain("Closing observations after the report.")
      expect(result.output).toContain("<alphacode-review>")
      expect(result.metadata.review.report).toEqual(REVIEW_REPORT)
    }),
  )

  it.instance("a missing review report envelope fails delivery explicitly", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runReview(reviewRunOps([REVIEW_ANALYSIS, ""])))

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.pretty(exit.cause)
      expect(error).toContain("Review delivery failed")
      expect(error).toContain("no <alphacode-review> report envelope was found")
      // The human-readable analysis is preserved in the failure, bounded.
      expect(error).toContain(REVIEW_ANALYSIS)
    }),
  )

  it.instance("a review run that ends without a completed finish call fails explicitly", () =>
    Effect.gen(function* () {
      // The envelope is present in the text, but no finish tool part completed:
      // termination without a successful finish must not silently become a
      // completed review.
      const exit = yield* Effect.exit(runReview(reviewOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope()}`])))

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.pretty(exit.cause)
      expect(error).toContain("Review delivery failed")
      expect(error).toContain("ended without a completed finish call")
    }),
  )

  it.instance("a malformed review report envelope fails delivery explicitly", () =>
    Effect.gen(function* () {
      const malformed = ["<alphacode-review>", "{ not json", "</alphacode-review>"].join("\n")
      const exit = yield* Effect.exit(runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${malformed}`])))

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.pretty(exit.cause)
      expect(error).toContain("Review delivery failed")
      expect(error).toContain("the envelope content is not a JSON object")
    }),
  )

  it.instance("an unknown review report schema version fails delivery explicitly", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope({ ...REVIEW_REPORT, version: 2 })}`])),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.pretty(exit.cause)
      expect(error).toContain("Review delivery failed")
      expect(error).toContain("unknown report schema version 2")
    }),
  )

  it.instance("a zero-finding review delivers a valid report", () =>
    Effect.gen(function* () {
      const clean = { ...REVIEW_REPORT, assessment: "approved", summary: "Nothing to report.", findings: [] }
      const result = yield* runReview(reviewRunOps([`${REVIEW_ANALYSIS}\n\n${reviewEnvelope(clean)}`]))

      expect(result.output).toContain('"approved"')
      expect(result.metadata.review.report).toEqual(clean)
      expect(result.metadata.review.report.findings).toEqual([])
    }),
  )

  it.instance("a background review with no report envelope surfaces an explicit delivery failure", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()

      const promptOps: TaskPromptOps = {
        ...reviewOps([REVIEW_ANALYSIS]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.sync(() => replyParts(input, [REVIEW_ANALYSIS])),
      }

      const result = yield* def.execute(
        {
          description: "review cache fix",
          prompt: "review the cache fix",
          subagent_type: "review",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("Review delivery failed")
      const notification = yield* Effect.promise(() => injected.promise)
      if (notification.parts[0]?.type === "text") {
        expect(notification.parts[0].text).toContain("<task_error>")
        expect(notification.parts[0].text).toContain("Review delivery failed")
      }
    }),
  )

  it.instance("default task invocations run asynchronously without blocking the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            // The child never finishes; the parent must still return.
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.metadata.sessionId).toBeDefined()
      expect(result.output).toContain(`state="running"`)
      expect(result.output).toContain("You will be notified automatically")
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  it.instance("explicit foreground execution (background=false) waits for the child result", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const started = defer<SessionID>()
      const done = defer<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.promise(async () => {
            started.resolve(input.sessionID)
            await done.promise
            return reply(input, "foreground done")
          }),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      // While the child is still running the job must be foreground and the
      // parent must still be blocked; background-only jobs immediately set
      // metadata.background=true.
      const sessionID = yield* Effect.promise(() => started.promise)
      const job = yield* jobs.get(sessionID)
      expect(job?.status).toBe("running")
      expect(job?.metadata?.background).toBeUndefined()

      done.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.metadata.background).toBeUndefined()
        expect(exit.value.output).toContain(`state="completed"`)
        expect(exit.value.output).toContain("foreground done")
      }
      expect((yield* jobs.get(sessionID))?.status).toBe("completed")
    }),
  )

  it.instance("multiple background tasks run concurrently", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const startA = defer<void>()
      const startB = defer<void>()
      const doneA = defer<void>()
      const doneB = defer<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.promise(async () => {
            const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
            const isA = text.includes("task A")
            ;(isA ? startA : startB).resolve()
            await (isA ? doneA : doneB).promise
            return reply(input, text)
          }),
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const resultA = yield* def.execute(
        { description: "task A", prompt: "investigate task A", subagent_type: "general" },
        context,
      )
      const resultB = yield* def.execute(
        { description: "task B", prompt: "investigate task B", subagent_type: "general" },
        context,
      )

      expect(resultA.metadata.sessionId).not.toBe(resultB.metadata.sessionId)
      yield* Effect.promise(() => startA.promise)
      yield* Effect.promise(() => startB.promise)

      expect((yield* jobs.get(resultA.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(resultB.metadata.sessionId))?.status).toBe("running")

      doneA.resolve()
      doneB.resolve()
      const waitedA = yield* jobs.wait({ id: resultA.metadata.sessionId, timeout: 1_000 })
      const waitedB = yield* jobs.wait({ id: resultB.metadata.sessionId, timeout: 1_000 })
      expect(waitedA.info?.status).toBe("completed")
      expect(waitedB.info?.status).toBe("completed")
      expect(waitedA.info?.output).toContain("task A")
      expect(waitedB.info?.output).toContain("task B")
    }),
  )

  it.instance("background task failures are surfaced to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.fail(new Error("boom")).pipe(Effect.orDie),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toBe("boom")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.sessionID).toBe(chat.id)
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") {
        expect(notification.parts[0].text).toContain("<task_error>")
        expect(notification.parts[0].text).toContain("boom")
      }
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  it.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  it.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  it.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  it.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  it.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  // A user cancelling the subagent they are watching reaches the runtime as a
  // cancel of that child session. The parent is blocked on this tool call, and
  // a free-form failure would leave it re-deriving the outcome from prose; the
  // typed termination is what lets it continue orchestration knowing the child
  // did not succeed.
  it.instance("cancelling a blocking subagent returns a typed cancellation to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const started = defer<SessionID>()
      const cancelled = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            started.resolve(input.sessionID)
          }).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "work",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const child = yield* Effect.promise(() => started.promise)
      expect((yield* jobs.get(child))?.status).toBe("running")

      yield* runState.cancel(child)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.termination.reason).toBe("cancelled")
      expect(result.output).toContain(`<task id="${child}" state="cancelled">`)
      expect(result.output).toContain('<termination reason="cancelled">')
      expect(result.output).toContain("cancelled by the user")
      // The cancel reached the child's execution handle itself, not only the
      // envelope handed back to the parent.
      expect((yield* jobs.get(child))?.status).toBe("cancelled")
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(child)
    }),
  )

  it.instance("a cancelled background subagent notifies the parent with a typed cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      const started = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.resolve(input)
                return reply(input, "notified")
              })
            : Effect.sync(() => {
                started.resolve(input.sessionID)
              }).pipe(Effect.andThen(Effect.never)),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = result.metadata.sessionId
      yield* Effect.promise(() => started.promise)

      yield* runState.cancel(child)

      expect((yield* jobs.wait({ id: child, timeout: 1_000 })).info?.status).toBe("cancelled")
      const notification = yield* Effect.promise(() => injected.promise)
      const text = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""
      expect(notification.sessionID).toBe(chat.id)
      expect(text).toContain(`<task id="${child}" state="cancelled">`)
      expect(text).toContain("<summary>Background task cancelled: inspect bug</summary>")
      expect(text).toContain('<termination reason="cancelled">')
      expect(text).toContain("cancelled by the user")
    }),
  )

  // Ctrl+C (or the parent's own double-Esc) cancels the parent run, and the
  // teardown sweeps up every job underneath it. Reporting those cancellations
  // back would prompt the session that is stopping and undo the interrupt, so
  // an ancestor-driven cancel must be swallowed while a targeted one is not.
  it.instance("a parent teardown sweeps a background subagent without notifying the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injections: string[] = []
      const started = defer<SessionID>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                const part = input.parts[0]
                injections.push(part?.type === "text" ? part.text : "")
                return reply(input, "notified")
              })
            : Effect.sync(() => {
                started.resolve(input.sessionID)
              }).pipe(Effect.andThen(Effect.never)),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = result.metadata.sessionId
      yield* Effect.promise(() => started.promise)

      yield* runState.cancel(chat.id)

      const swept = yield* jobs.wait({ id: child, timeout: 1_000 })
      expect(swept.info?.status).toBe("cancelled")
      // The tag is what distinguishes "the user stopped this child" from "the
      // session above it stopped and took the child with it".
      expect(swept.info?.cancelledByTeardown).toBe(true)

      // The job has settled, so the watcher has everything it needs to deliver
      // a notification. It must never do so, teardown cancels are dropped.
      const notified = yield* pollWithTimeout(
        Effect.sync(() => (injections.length > 0 ? injections.join("\n") : undefined)),
        "a teardown cancel notified the parent",
        "250 millis",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(notified)).toBe(true)
      expect(injections).toEqual([])
    }),
  )

  // Double-Esc is scoped to the trace it is pressed in. Cancelling one child
  // must not reach the sibling's job or the parent's own run, and the parent
  // must still be driven by the sibling's completion afterwards.
  it.instance("cancelling one subagent leaves its sibling and the parent's orchestration intact", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed("Isolation")
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injections: string[] = []
      const delivered = defer<void>()
      const runningB = defer<void>()
      const gates = new Map<string, () => void>()
      const hold = (key: string) => {
        const entry = defer<void>()
        gates.set(key, () => entry.resolve())
        return entry.promise
      }
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Effect.sync(() => {
              const part = input.parts[0]
              injections.push(part?.type === "text" ? part.text : "")
              if (injections.length === 2) delivered.resolve()
              return reply(input, "notified")
            })
          }
          const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
          const key = text.includes("task B") ? "B" : "A"
          const gate = hold(key)
          if (key === "B") runningB.resolve()
          return Effect.promise(() => gate).pipe(Effect.as(reply(input, `${key} done`)))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const a = yield* def.execute(
        { description: "task A", prompt: "investigate task A", subagent_type: "general" },
        context,
      )
      const b = yield* def.execute(
        { description: "task B", prompt: "investigate task B", subagent_type: "general" },
        context,
      )
      yield* Effect.promise(() => runningB.promise)

      yield* runState.cancel(a.metadata.sessionId)

      expect((yield* jobs.get(a.metadata.sessionId))?.status).toBe("cancelled")
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")

      gates.get("B")?.()
      expect((yield* jobs.wait({ id: b.metadata.sessionId, timeout: 1_000 })).info?.status).toBe("completed")

      yield* Effect.promise(() => delivered.promise)
      expect(injections.find((text) => text.includes('state="cancelled"'))).toContain(
        "<summary>Background task cancelled: task A</summary>",
      )
      expect(injections.find((text) => text.includes('state="completed"'))).toContain("task B")
    }),
  )

  it.instance("a declared terminal reason delivers the same termination in the background and the foreground", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const tool = yield* TaskTool
      const def = yield* tool.init()
      for (const reason of ["subagent_wait", "failure", "success"] as const) {
        const { chat, assistant } = yield* seed(`Parity ${reason}`)
        const injected = defer<SessionPrompt.PromptInput>()
        const child = finishRunOps(reason, "child done")
        const context = (promptOps: TaskPromptOps) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const params = {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        }

        const foreground = yield* def.execute({ ...params, background: false }, context(child))
        expect(foreground.metadata.termination.reason).toBe(reason)
        expect(terminationOf(foreground.output)).toBeDefined()

        const background = yield* def.execute(
          { ...params, background: true },
          context({
            ...child,
            prompt: (input) =>
              input.sessionID === chat.id
                ? Effect.sync(() => {
                    injected.resolve(input)
                    return reply(input, "notified")
                  })
                : child.prompt(input),
          }),
        )
        yield* jobs.wait({ id: background.metadata.sessionId, timeout: 1_000 })
        const notification = yield* Effect.promise(() => injected.promise)
        const delivered = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""

        expect(delivered).toContain("child done")
        // The contract: both delivery paths expose the same termination to the
        // parent. These two assertions are what fail if the paths diverge, and
        // the parity check alone would also pass if both sides rendered nothing.
        expect(terminationOf(foreground.output)).toContain(`<termination reason="${reason}">`)
        expect(terminationOf(delivered)).toBe(terminationOf(foreground.output))
        if (reason === "subagent_wait") {
          expect(terminationOf(delivered)).toContain("not in flight")
        }
      }
    }),
  )

  // A declared yield has no delivered counterpart: the finish tool refuses the
  // wait for a session that is itself a subagent, so a child should not declare
  // it at all, and a transcript that still does must not put a provisional
  // result on the wire as a terminal one. The result text still arrives - what
  // is dropped is the termination element and its metadata.
  it.instance("a declared yield delivers no termination to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const { chat, assistant } = yield* seed("Yield drop")
      const injected = defer<SessionPrompt.PromptInput>()
      const child = finishRunOps("waiting_for_subagent", "child yielded")
      const context = (promptOps: TaskPromptOps) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "work",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })
      const params = {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      }

      const foreground = yield* def.execute({ ...params, background: false }, context(child))
      expect(foreground.output).toContain("child yielded")
      expect(terminationOf(foreground.output)).toBeUndefined()
      expect(foreground.metadata.termination).toBeUndefined()

      const background = yield* def.execute(
        { ...params, background: true },
        context({
          ...child,
          prompt: (input) =>
            input.sessionID === chat.id
              ? Effect.sync(() => {
                  injected.resolve(input)
                  return reply(input, "notified")
                })
              : child.prompt(input),
        }),
      )
      yield* jobs.wait({ id: background.metadata.sessionId, timeout: 1_000 })
      const notification = yield* Effect.promise(() => injected.promise)
      const delivered = notification.parts[0]?.type === "text" ? notification.parts[0].text : ""

      expect(delivered).toContain("child yielded")
      expect(terminationOf(delivered)).toBeUndefined()
    }),
  )
})

describe("tool.task - child write handoff", () => {
  for (const outcome of ["completed", "error", "background"] as const) {
    it.instance(`projects child writes before ${outcome} delivery`, () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const sessions = yield* Session.Service
        const parentPart: SessionV1.ToolPart = {
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistant.id,
          type: "tool",
          tool: "task",
          callID: "parent-write-task",
          state: {
            status: "running",
            input: { subagent_type: "general", background: false },
            time: { start: Date.now() },
          },
        }
        yield* sessions.updatePart(parentPart)
        const jobs = yield* BackgroundJob.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let observed: Record<string, any> = {}
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              const response = reply(input, "changed files")
              yield* sessions.updateMessage(response.info)
              const part: SessionV1.ToolPart = {
                id: PartID.ascending(),
                sessionID: input.sessionID,
                messageID: response.info.id,
                type: "tool",
                tool: "write",
                callID: "child-write",
                state: {
                  status: "completed",
                  input: {},
                  output: "written",
                  title: "write",
                  metadata: { reviewLoop: { writesFiles: true } },
                  time: { start: Date.now(), end: Date.now() },
                },
              }
              yield* sessions.updatePart(part)
              const parentHistory = yield* sessions.messages({ sessionID: chat.id })
              const persisted = parentHistory.flatMap((m) => m.parts).find((p) => p.id === parentPart.id)
              expect(
                persisted?.type === "tool" &&
                  persisted.state.status === "running" &&
                  persisted.state.metadata?.reviewLoop?.writesFiles,
              ).toBe(true)
              if (outcome === "error") return yield* Effect.fail(new Error("Child crashed after write"))
              return { ...response, parts: [...response.parts, part] }
            }).pipe(Effect.orDie),
        }
        const exit = yield* def
          .execute(
            { description: "write", prompt: "write", subagent_type: "general", background: outcome === "background" },
            {
              callID: "parent-write-task",
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "work",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: (value) =>
                Effect.sync(() => {
                  observed = value.metadata ?? {}
                }),
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        if (outcome === "background" && Exit.isSuccess(exit)) {
          yield* jobs.wait({ id: exit.value.metadata.sessionId })
        }
        const parentHistory = yield* sessions.messages({ sessionID: chat.id })
        const persisted = parentHistory.flatMap((m) => m.parts).find((p) => p.id === parentPart.id)
        expect(
          persisted?.type === "tool" &&
            persisted.state.status === "running" &&
            persisted.state.metadata?.reviewLoop?.writesFiles,
        ).toBe(true)
        if (outcome === "completed") {
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            expect(exit.value.metadata.review?.termination).toBe("review-pending")
            expect(exit.value.output).toContain("UNREVIEWED")
          }
        } else if (outcome === "error") expect(Exit.isFailure(exit)).toBe(true)
        else expect(Exit.isSuccess(exit)).toBe(true)
      }),
    )
  }
})
