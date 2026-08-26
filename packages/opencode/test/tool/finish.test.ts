import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FinishTool } from "@/tool/finish"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      SessionProjector.node,
      Todo.node,
      Truncate.node,
      Agent.node,
      Config.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
  )

const it = testEffect(layer())

const seedSession = Effect.fn("FinishTest.seedSession")(function* (title = "test") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "work",
    model: { providerID: "test" as any, modelID: "test-model" as any },
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
    modelID: "test-model" as any,
    providerID: "test" as any,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

describe("tool.finish – todo closure safety net", () => {
  it.instance("closes pending todos", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "pending task", status: "pending", priority: "high" },
          { content: "another pending", status: "pending", priority: "low" },
        ],
      })

      const result = yield* def.execute(
        { result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.title).toBe("Task completed")
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(2)
      expect(after.every((t) => t.status !== "pending")).toBe(true)
      expect(after.every((t) => t.status !== "in_progress")).toBe(true)
      expect(after.every((t) => t.status === "cancelled")).toBe(true)
    }),
  )

  it.instance("closes in_progress todos", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "active task", status: "in_progress", priority: "high" }],
      })

      yield* def.execute(
        { result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(1)
      expect(after[0].status).toBe("cancelled")
    }),
  )

  it.instance("leaves no open todos after finish", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "pending", status: "pending", priority: "high" },
          { content: "active", status: "in_progress", priority: "high" },
          { content: "done", status: "completed", priority: "low" },
        ],
      })

      yield* def.execute(
        { result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      const open = after.filter((t) => t.status === "pending" || t.status === "in_progress")
      expect(open).toHaveLength(0)
    }),
  )

  it.instance("already-completed todos remain completed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "done 1", status: "completed", priority: "high" },
          { content: "pending", status: "pending", priority: "medium" },
        ],
      })

      yield* def.execute(
        { result: "done" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const after = yield* todos.get(chat.id)
      expect(after.find((t) => t.content === "done 1")?.status).toBe("completed")
      expect(after.find((t) => t.content === "pending")?.status).toBe("cancelled")
    }),
  )

  it.instance("does not modify unrelated sessions' todos", () =>
    Effect.gen(function* () {
      const { chat: chatA, assistant: assistantA } = yield* seedSession("session A")
      const { chat: chatB } = yield* seedSession("session B")
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      yield* todos.update({
        sessionID: chatA.id,
        todos: [{ content: "A pending", status: "pending", priority: "high" }],
      })
      yield* todos.update({
        sessionID: chatB.id,
        todos: [{ content: "B pending", status: "pending", priority: "high" }],
      })

      yield* def.execute(
        { result: "done A" },
        {
          sessionID: chatA.id,
          messageID: assistantA.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const afterA = yield* todos.get(chatA.id)
      const afterB = yield* todos.get(chatB.id)

      expect(afterA[0].status).toBe("cancelled")
      expect(afterB[0].status).toBe("pending")
    }),
  )

  it.instance("handles empty todo list gracefully", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seedSession()
      const todos = yield* Todo.Service
      const tool = yield* FinishTool
      const def = yield* tool.init()

      const before = yield* todos.get(chat.id)
      expect(before).toHaveLength(0)

      const result = yield* def.execute(
        { result: "nothing to do" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.title).toBe("Task completed")
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(0)
    }),
  )
})

describe("todo state – granular planning and sequential execution", () => {
  it.instance("todo items can represent granular sequential work", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      const granularPlan = [
        { content: "Trace current model-selection state flow", status: "pending" as const, priority: "high" as const },
        { content: "Trace agent-turn configuration resolution", status: "pending" as const, priority: "high" as const },
        { content: "Identify where pending configuration is deferred", status: "pending" as const, priority: "high" as const },
        { content: "Define next-turn configuration semantics", status: "pending" as const, priority: "medium" as const },
        { content: "Implement pending model state", status: "pending" as const, priority: "high" as const },
        { content: "Add model-switch test", status: "pending" as const, priority: "medium" as const },
        { content: "Run targeted tests", status: "pending" as const, priority: "medium" as const },
        { content: "Review final diff", status: "pending" as const, priority: "low" as const },
      ]

      yield* todos.update({ sessionID: chat.id, todos: granularPlan })
      const stored = yield* todos.get(chat.id)
      expect(stored).toHaveLength(8)
      expect(stored[0].content).toBe("Trace current model-selection state flow")
    }),
  )

  it.instance("one item can remain active while agent performs operations", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Trace how model configuration reaches the agent turn", status: "in_progress", priority: "high" },
          { content: "Implement feature", status: "pending", priority: "high" },
        ],
      })

      const current = yield* todos.get(chat.id)
      const active = current.filter((t) => t.status === "in_progress")
      expect(active).toHaveLength(1)
      expect(active[0].content).toBe("Trace how model configuration reaches the agent turn")

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Trace how model configuration reaches the agent turn", status: "completed", priority: "high" },
          { content: "Implement feature", status: "in_progress", priority: "high" },
        ],
      })

      const after = yield* todos.get(chat.id)
      expect(after[0].status).toBe("completed")
      expect(after[1].status).toBe("in_progress")
    }),
  )

  it.instance("completed items transition correctly", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "pending", priority: "high" }],
      })
      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "in_progress", priority: "high" }],
      })
      let stored = yield* todos.get(chat.id)
      expect(stored[0].status).toBe("in_progress")

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task", status: "completed", priority: "high" }],
      })
      stored = yield* todos.get(chat.id)
      expect(stored[0].status).toBe("completed")
    }),
  )

  it.instance("newly discovered work can be added without corrupting existing state", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Implement feature", status: "completed", priority: "high" },
          { content: "Run tests", status: "in_progress", priority: "medium" },
        ],
      })

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "Implement feature", status: "completed", priority: "high" },
          { content: "Run tests", status: "in_progress", priority: "medium" },
          { content: "Fix edge case discovered during testing", status: "pending", priority: "high" },
        ],
      })

      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(3)
      expect(after[0].status).toBe("completed")
      expect(after[1].status).toBe("in_progress")
      expect(after[2].content).toBe("Fix edge case discovered during testing")
    }),
  )

  it.instance("creating, updating, completing, removing items works", () =>
    Effect.gen(function* () {
      const { chat } = yield* seedSession()
      const todos = yield* Todo.Service

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "pending", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(chat.id))).toHaveLength(2)

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "in_progress", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(chat.id))[0].status).toBe("in_progress")

      yield* todos.update({
        sessionID: chat.id,
        todos: [
          { content: "task 1", status: "completed", priority: "high" },
          { content: "task 2", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(chat.id))[0].status).toBe("completed")

      yield* todos.update({
        sessionID: chat.id,
        todos: [{ content: "task 1 revised", status: "completed", priority: "high" }],
      })
      const after = yield* todos.get(chat.id)
      expect(after).toHaveLength(1)
      expect(after[0].content).toBe("task 1 revised")

      yield* todos.update({ sessionID: chat.id, todos: [] })
      expect((yield* todos.get(chat.id))).toHaveLength(0)
    }),
  )
})
