import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MCP } from "@/mcp"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Permission } from "@/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
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
    MCP.node,
  ]),
)

const it = testEffect(layer)

// The read-only delegation sandbox denies whatever `Permission.mutatingKeys`
// derives from the live registry. These tests exercise that derivation against
// the real registry (not a stubbed `mutatingPermissionKeys`), so the safety
// property — "a read-only child is safe if and only if every state-changing
// tool is covered" — is pinned to the tool metadata itself.
describe("mutating tool metadata contract", () => {
  it.instance("the read-only sandbox covers exactly the registered mutating tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()

      // Audit: the exact registered tools that declare `mutates: true`. If a
      // state-changing tool forgets the trait — or a read-only tool wrongly
      // gains it — this fails and forces a deliberate decision.
      const mutatingIds = all.filter((tool) => tool.metadata?.mutates === true).map((tool) => tool.id).toSorted()
      expect(mutatingIds).toEqual(["apply_patch", "bash", "delegate", "edit", "task", "write"])

      // The sandbox denies the permission keys those tools ask with. edit,
      // write, and apply_patch all declare the "edit" key, so three tools
      // collapse to one deny rule.
      expect(Permission.mutatingKeys(all).toSorted()).toEqual(["bash", "delegate", "edit", "task"])
    }),
  )

  it.instance("deriving the deny set from the registry discovers a newly declared mutating tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()

      // A brand-new tool declaring the trait, fed through the same derivation
      // the runtime applies to `registry.all()`. No denylist update is needed:
      // declaring `mutates: true` is the only step to be covered.
      const synthetic = { id: "custom_mutator", metadata: { mutates: true } }
      expect(Permission.mutatingKeys([...all, synthetic]).toSorted()).toEqual([
        "bash",
        "custom_mutator",
        "delegate",
        "edit",
        "task",
      ])

      // And a tool that does NOT declare the trait stays out of the deny set.
      const reader = { id: "custom_reader", metadata: {} }
      expect(Permission.mutatingKeys([...all, reader])).not.toContain("custom_reader")
    }),
  )
})
