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
    }),
  )
})
