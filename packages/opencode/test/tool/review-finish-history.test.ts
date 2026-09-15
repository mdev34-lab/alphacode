import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, PartID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FinishTool } from "@/tool/finish"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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

afterEach(async () => {
  await disposeAllInstances()
})

const report = `<alphacode-review>\n${JSON.stringify({
  version: 1,
  revision: "uncommitted",
  assessment: "approved",
  summary: "Historical report",
  findings: [],
})}\n</alphacode-review>`

describe("tool.finish – current review result", () => {
  it.instance("does not accept a report from an earlier assistant turn", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const chat = yield* session.create({ title: "review" })
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "review",
        model: { providerID: "test" as any, modelID: "test-model" as any },
        time: { created: Date.now() },
      })
      const historical = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: chat.id,
        mode: "work",
        agent: "review",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model" as any,
        providerID: "test" as any,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: historical.id,
        sessionID: chat.id,
        type: "text",
        text: report,
      })
      const current = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: historical.id,
        sessionID: chat.id,
        mode: "work",
        agent: "review",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model" as any,
        providerID: "test" as any,
        time: { created: Date.now() },
      })
      const tool = yield* FinishTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { result: "Historical report must not count." },
          {
            sessionID: chat.id,
            messageID: current.id,
            agent: "review",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
      expect(failure).toBeInstanceOf(ToolFailure)
      expect((failure as ToolFailure).message).toContain("no <alphacode-review> report envelope was found")
    }),
  )
})
