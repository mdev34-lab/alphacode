import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { FinishTool } from "@/tool/finish"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ReviewReport } from "@opencode-ai/core/review-report"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Config.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Todo.node,
      ToolRegistry.node,
      Truncate.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  )

const it = testEffect(layer())

afterEach(async () => {
  await disposeAllInstances()
})

const report = {
  version: 1,
  revision: "uncommitted",
  assessment: "needs-fixes",
  summary: "One important finding.",
  findings: [{ severity: "important", title: "Off-by-one" }],
}

const envelope = ["<alphacode-review>", JSON.stringify(report, null, 2), "</alphacode-review>"].join("\n")

const createAssistant = (input: { sessionID: string; messageID: string; agent: string }): SessionV1.Assistant => ({
  id: input.messageID as MessageID,
  role: "assistant",
  parentID: MessageID.ascending(),
  sessionID: input.sessionID as SessionV1.Assistant["sessionID"],
  mode: "work",
  agent: input.agent,
  cost: 0,
  path: { cwd: "/tmp", root: "/tmp" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ref.modelID,
  providerID: ref.providerID,
  time: { created: Date.now() },
  finish: "stop",
})

describe("TaskTool review delivery", () => {
  it.instance("requires a real FinishTool success after recoverable invalid finish feedback", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const finish = yield* FinishTool
      const task = yield* TaskTool
      const taskDef = yield* task.init()
      const finishDef = yield* finish.init()

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const message = createAssistant(input as { sessionID: string; messageID: string; agent: string })
            yield* session.updateMessage(message)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: message.id,
              sessionID: input.sessionID,
              type: "text",
              text: envelope,
            })

            const context = {
              sessionID: input.sessionID,
              messageID: message.id,
              agent: "review",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            }

            const invalid = yield* finishDef.execute({ result: "Needs fixes: one Important finding" }, context).pipe(Effect.exit)
            expect(Exit.isFailure(invalid)).toBe(true)
            if (!Exit.isFailure(invalid)) return yield* Effect.fail(new Error("expected invalid finish to fail"))
            const failure = invalid.cause.reasons.find(Cause.isFailReason)?.error
            expect(failure).toBeInstanceOf(ToolFailure)

            const finished = yield* finishDef.execute({ result: envelope }, context)
            const completed: SessionV1.ToolPart = {
              id: PartID.ascending(),
              messageID: message.id,
              sessionID: input.sessionID,
              type: "tool",
              tool: "finish",
              callID: "finish-call",
              state: {
                status: "completed",
                input: { result: envelope },
                output: finished.output,
                title: finished.title,
                metadata: finished.metadata ?? {},
                time: { start: Date.now(), end: Date.now() },
              },
            }

            return { info: message, parts: [{ id: PartID.ascending(), messageID: message.id, sessionID: input.sessionID, type: "text" as const, text: envelope }, completed] }
          }),
      }

      const parent = yield* session.create({ title: "review" })
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: parent.id,
        agent: "work",
        model: ref,
        time: { created: Date.now() },
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: parent.id,
        mode: "work",
        agent: "work",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* session.updateMessage(assistant)

      const result = yield* taskDef.execute(
        { description: "review", prompt: "review", subagent_type: "review", background: false },
        {
          sessionID: parent.id,
          messageID: assistant.id,
          agent: "work",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("<alphacode-review>")
      expect(result.metadata.review.report).toEqual(report)
      expect(ReviewReport.extract([result.output]).ok).toBe(true)
    }),
  )
})
