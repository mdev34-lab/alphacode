import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Command.node, CommandV2.node, Config.node, MCP.node, Skill.node])),
)

describe("CommandV2 bridge", () => {
  it.instance("syncs factory default commands into CommandV2", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.list()
      const commandV2 = yield* CommandV2.Service
      const names = (yield* commandV2.list()).map((c) => c.name)
      expect(names).toContain("init")
      expect(names).toContain("review")

      const init = yield* commandV2.get("init")
      expect(init?.name).toBe("init")
      expect(init?.template).toContain("AGENTS.md")

      const review = yield* commandV2.get("review")
      expect(review?.name).toBe("review")
      expect(review?.template).toContain("review")
      expect(review?.subtask).toBe(true)
    }),
  )

  it.instance(
    "syncs configured command model, agent, subtask, and template into CommandV2",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        yield* command.list()
        const commandV2 = yield* CommandV2.Service
        const custom = yield* commandV2.get("my-cmd")
        expect(custom).toBeDefined()
        expect(custom?.agent).toBe("build")
        expect(custom?.subtask).toBe(true)
        expect(custom?.template).toBe("echo hello")
      }),
    {
      config: {
        command: {
          "my-cmd": {
            agent: "build",
            model: "anthropic/claude-3-opus-20240229",
            description: "test command",
            template: "echo hello",
            subtask: true,
          },
        },
      },
    },
  )
})
