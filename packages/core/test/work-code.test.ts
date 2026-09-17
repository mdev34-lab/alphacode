import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

const projectDir = mkdtempSync(path.join(tmpdir(), "alphacode-test-project-"))

function evaluate(action: string, resource: string, rules: PermissionV2.Ruleset) {
  const rule =
    rules.findLast((r) => Wildcard.match(action, r.action) && Wildcard.match(resource, r.resource)) ?? {
      action,
      resource: "*",
      effect: "ask" as const,
    }
  return rule.effect
}

const agentIt = testEffect(AppNodeBuilder.build(AgentV2.node))

const toolIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

describe("Work/Code agent split (core)", () => {
  agentIt.effect("work resolves to Work agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const work = yield* agent.get(AgentV2.ID.make("work"))
      expect(work).toBeDefined()
      expect(String(work?.id)).toBe("work")
      expect(work?.mode).toBe("primary")
    }),
  )

  agentIt.effect("code resolves to Code agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(code).toBeDefined()
      expect(String(code?.id)).toBe("code")
      expect(code?.mode).toBe("all")
    }),
  )

  agentIt.effect("work can delegate to code through real delegation path", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const work = yield* agent.get(AgentV2.ID.make("work"))
      expect(work).toBeDefined()
      expect(evaluate("task", "code", work!.permissions)).toBe("allow")
    }),
  )

  agentIt.effect("code cannot delegate to work", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(code).toBeDefined()
      expect(evaluate("task", "work", code!.permissions)).toBe("deny")
    }),
  )

  agentIt.effect("code receives LSP tools, work does not (permission)", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const work = yield* agent.get(AgentV2.ID.make("work"))
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(work).toBeDefined()
      expect(code).toBeDefined()

      expect(evaluate("lsp", "*", work!.permissions)).toBe("deny")
      expect(evaluate("lsp", "*", code!.permissions)).toBe("allow")
    }),
  )

  agentIt.effect("existing agents and delegation behavior unchanged", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
        ),
      )
      const plan = yield* agent.get(AgentV2.ID.make("plan"))
      const explore = yield* agent.get(AgentV2.ID.make("explore"))
      const general = yield* agent.get(AgentV2.ID.make("general"))

      expect(plan).toBeDefined()
      expect(explore).toBeDefined()
      expect(general).toBeDefined()

      expect(evaluate("edit", "*", plan!.permissions)).toBe("deny")
      expect(evaluate("task", "*", explore!.permissions)).toBe("deny")
    }),
  )

  toolIt.effect("code receives LSP tools/context, work does not (registry)", () =>
    Effect.gen(function* () {
      const apps = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service

      // Register minimal lsp and task tools to simulate real registry
      const lspTool = Tool.make({
        description: "LSP tool",
        input: Schema.Struct({ op: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("lsp result"),
      })
      const taskTool = Tool.make({
        description: "Task tool",
        input: Schema.Struct({ subagent_type: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("task result"),
      })
      yield* apps.register({ lsp: lspTool, task: taskTool })

      // Simulate work and code permissions
      const workPermissions: PermissionV2.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "deny" },
      ]
      const codePermissions: PermissionV2.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "allow" },
        { action: "task", resource: "work", effect: "deny" },
      ]

      const workMat = yield* registry.materialize(workPermissions)
      const codeMat = yield* registry.materialize(codePermissions)

      const workHasLsp = workMat.definitions.some((d) => d.name === "lsp")
      const codeHasLsp = codeMat.definitions.some((d) => d.name === "lsp")
      const workHasTask = workMat.definitions.some((d) => d.name === "task")
      const codeHasTask = codeMat.definitions.some((d) => d.name === "task")

      expect(workHasLsp).toBe(false)
      expect(codeHasLsp).toBe(true)
      expect(workHasTask).toBe(true)
      expect(codeHasTask).toBe(true)

      // Delegation direction via permission evaluation
      const workCanDelegateToCode = evaluate("task", "code", workPermissions) === "allow"
      const codeCanDelegateToWork = evaluate("task", "work", codePermissions) === "allow"
      expect(workCanDelegateToCode).toBe(true)
      expect(codeCanDelegateToWork).toBe(false)
    }),
  )
})
