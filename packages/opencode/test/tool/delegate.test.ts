import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { commitRules, deriveDelegationResult, type DelegationResult } from "../../src/tool/delegate"
import { DelegateTool } from "../../src/tool/delegate"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
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
      FSUtil.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())

const seed = Effect.fn("DelegateToolTest.seed")(function* (title = "Delegation parent") {
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

/** Seeds a completed child transcript: writes, a passing and a failing test run, and a JSON finish report. */
const seedChildTranscript = Effect.fn("DelegateToolTest.seedChildTranscript")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "code",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "code",
    agent: "code",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  const now = Date.now()
  const part = (tool: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
    session.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "tool",
      tool,
      callID: `${tool}-call`,
      state: { status: "completed", input, output: "ok", title: tool, metadata, time: { start: now, end: now } },
    })
  yield* part("write", { filePath: "/repo/src/a.txt", content: "a" })
  yield* part("edit", { filePath: "/repo/src/b.txt" })
  yield* part("bash", { command: "bun test" }, { exit: 0 })
  yield* part("bash", { command: "npm test" }, { exit: 1 })
  yield* part("bash", { command: "git status" })
  yield* part("finish", { result: '{"summary":"Fixed the thing","warnings":["flaky test in b.txt"]}' })
})

function stubOps(
  session?: Session.Interface,
  opts?: {
    onPrompt?: (input: SessionPrompt.PromptInput) => void
    prompt?: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts>
  },
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      opts?.prompt
        ? opts.prompt(input)
        : Effect.gen(function* () {
            opts?.onPrompt?.(input)
            if (session)
              yield* seedChildTranscript(input.sessionID as SessionID).pipe(
                Effect.provideService(Session.Service, session),
              )
            return {
              info: { role: "assistant" as const },
              parts: [],
            } as unknown as SessionV1.WithParts
          }),
  }
}

const context = (input: {
  sessionID: SessionID
  messageID: MessageID
  agent?: string
  extra?: Record<string, unknown>
}) => ({
  sessionID: input.sessionID,
  messageID: input.messageID,
  agent: input.agent ?? "work",
  abort: new AbortController().signal,
  extra: input.extra ?? {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const initTool = Effect.fnUntraced(function* () {
  const info = yield* DelegateTool
  return yield* info.init()
})

describe("tool.delegate", () => {
  it.instance("returns a machine-readable result with observed files, tests, and warnings", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      let contract: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps(sessions, { onPrompt: (input) => (contract = input) })
      const def = yield* initTool()

      const result = yield* def.execute(
        { agent: "code", task: "Fix the crash in a.txt" },
        context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps } }),
      )

      const reported = JSON.parse(result.output) as DelegationResult
      expect(reported.status).toBe("completed")
      expect(reported.summary).toBe("Fixed the thing")
      expect(reported.changedFiles).toEqual(["/repo/src/a.txt", "/repo/src/b.txt"])
      expect(reported.tests).toEqual([
        { command: "bun test", status: "passed", exitCode: 0 },
        { command: "npm test", status: "failed", exitCode: 1 },
      ])
      expect(reported.warnings).toContain("flaky test in b.txt")

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.agent).toBe("code")
      expect(result.metadata.sessionId).toBe(kids[0]?.id)
      expect(contract?.agent).toBe("code")
      expect(contract?.parts[0]?.type).toBe("text")
      expect((contract?.parts[0] as { text: string }).text).toContain("Working directory:")
    }),
  )

  it.instance("applies isolation constraints to the child session ruleset", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTool()

      const result = yield* def.execute(
        { agent: "code", task: "Inspect the build", constraints: { readOnly: true, allowCommit: false } },
        context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps: stubOps() } }),
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      const denies = (permission: string, pattern = "*") =>
        child.permission?.some((rule) => rule.permission === permission && rule.pattern === pattern && rule.action === "deny")
      expect(denies("bash")).toBe(true)
      expect(denies("edit")).toBe(true)
      expect(denies("write")).toBe(true)
      expect(denies("apply_patch")).toBe(true)
      expect(denies("bash", "git commit *")).toBe(true)
    }),
  )

  it.instance("asks permission with the target agent before delegating", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTool()
      const calls: unknown[] = []

      yield* def.execute(
        { agent: "code", task: "Organize the codebase" },
        {
          ...context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps: stubOps() } }),
          ask: (input) => Effect.sync(() => calls.push(input)),
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "delegate",
        patterns: ["code"],
        always: ["*"],
        metadata: {
          agent: "code",
          task: "Organize the codebase",
          cwd: undefined,
          constraints: undefined,
        },
      })
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("refuses to delegate to the current agent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTool()
      const exit = yield* def
        .execute(
          { agent: "code", task: "loop" },
          context({ sessionID: chat.id, messageID: assistant.id, agent: "code", extra: { promptOps: stubOps() } }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("refuses unknown agents", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* initTool()
      const exit = yield* def
        .execute(
          { agent: "nope", task: "task" },
          context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps: stubOps() } }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("keeps the delegation cwd inside the workspace", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTool()

      const outside = yield* def
        .execute(
          { agent: "code", task: "task", cwd: "/etc" },
          context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps: stubOps() } }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(outside)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)

      const missing = yield* def
        .execute(
          { agent: "code", task: "task", cwd: "does-not-exist" },
          context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps: stubOps() } }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )

  it.instance("enforces bounded nesting by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child", agent: "code" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const def = yield* initTool()

      const exit = yield* def
        .execute(
          { agent: "work", task: "nested" },
          context({ sessionID: child.id, messageID: nestedAssistant.id, agent: "code", extra: { promptOps: stubOps() } }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance("allows one nested delegation with subagent_depth 2", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child", agent: "code" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const def = yield* initTool()

      const result = yield* def.execute(
        { agent: "work", task: "nested" },
        context({ sessionID: child.id, messageID: nestedAssistant.id, agent: "code", extra: { promptOps: stubOps() } }),
      )
      expect((yield* sessions.get(result.metadata.sessionId as SessionID)).parentID).toBe(child.id)
    }),
    { config: { subagent_depth: 2 } },
  )

  it.instance("cancels the child and reports timeout past the deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const cancelled: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) => Effect.sync(() => cancelled.push(sessionID)),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        // A delegation that never settles; the deadline must win.
        prompt: () => Effect.promise<never>(() => new Promise(() => {})),
      }
      const def = yield* initTool()

      const result = yield* def.execute(
        { agent: "code", task: "slow task", timeoutMs: 100 },
        context({ sessionID: chat.id, messageID: assistant.id, extra: { promptOps } }),
      )

      const reported = JSON.parse(result.output) as DelegationResult
      expect(reported.status).toBe("timeout")
      expect(cancelled.length).toBeGreaterThanOrEqual(1)
      const kids = yield* sessions.children(chat.id)
      expect(cancelled).toContain(kids[0]?.id)
    }),
  )
})

describe("deriveDelegationResult", () => {
  it.effect("falls back to the raw finish text when it is not JSON", () =>
    Effect.sync(() => {
      const result = deriveDelegationResult({
      messages: [
        {
          info: { id: "m1", sessionID: "s1", role: "assistant" } as never,
          parts: [
            {
              type: "tool",
              tool: "finish",
              callID: "c1",
              id: "p1",
              messageID: "m1",
              sessionID: "s1",
              state: {
                status: "completed",
                input: { result: "All done, nothing to add" },
                output: "ok",
                title: "finish",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            } as never,
          ],
        },
      ],
        status: "completed",
      })
      expect(result.summary).toBe("All done, nothing to add")
      expect(result.warnings).toHaveLength(0)
    }),
  )

  it.effect("records failed tool calls as warnings and errors as status", () =>
    Effect.sync(() => {
      const result = deriveDelegationResult({
      messages: [
        {
          info: { id: "m1", sessionID: "s1", role: "assistant" } as never,
          parts: [
            {
              type: "tool",
              tool: "bash",
              callID: "c1",
              id: "p1",
              messageID: "m1",
              sessionID: "s1",
              state: {
                status: "error",
                input: { command: "bun test" },
                error: "boom",
                time: { start: 1, end: 2 },
              },
            } as never,
          ],
        },
      ],
        status: "error",
        failure: "provider exploded",
      })
      expect(result.status).toBe("error")
      expect(result.warnings).toContain("bash failed: boom")
      expect(result.warnings).toContain("provider exploded")
    }),
  )

  it.effect("reports a missing final report on completion", () =>
    Effect.sync(() => {
      const result = deriveDelegationResult({ messages: [], status: "completed" })
      expect(result.summary).toBe("Delegation finished without a final report.")
    }),
  )
})

describe("commitRules", () => {
  it.effect("denies git commit only when commits are disallowed", () =>
    Effect.sync(() => {
      expect(commitRules({ allowCommit: false })).toEqual([{ permission: "bash", pattern: "git commit *", action: "deny" }])
      expect(commitRules({ allowCommit: true })).toEqual([])
      expect(commitRules(undefined)).toEqual([])
    }),
  )
})
