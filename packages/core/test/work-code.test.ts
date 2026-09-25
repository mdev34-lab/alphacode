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

const projectDir = mkdtempSync(path.join(tmpdir(), "silvercode-test-project-"))

function evaluate(action: string, resource: string, rules: PermissionV2.Ruleset) {
  return PermissionV2.evaluate(action, resource, rules).effect
}

const agentIt = testEffect(AppNodeBuilder.build(AgentV2.node))

function loadAgents(agent: AgentV2.Interface) {
  return AgentPlugin.Plugin.effect(
    host({ agent: agentHost(agent) }),
  ).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(projectDir) })),
    ),
  )
}

describe("Work/Code agent split (core)", () => {
  agentIt.effect("work resolves to Work agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const work = yield* agent.get(AgentV2.ID.make("work"))
      expect(work).toBeDefined()
      expect(String(work?.id)).toBe("work")
      expect(work?.mode).toBe("primary")
    }),
  )

  agentIt.effect("code resolves to Code agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(code).toBeDefined()
      expect(String(code?.id)).toBe("code")
      expect(code?.mode).toBe("all")
    }),
  )

  agentIt.effect("work can delegate to code", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const work = yield* agent.get(AgentV2.ID.make("work"))
      expect(work).toBeDefined()
      expect(evaluate("task", "code", work!.permissions)).toBe("allow")
    }),
  )

  agentIt.effect("work cannot delegate to itself", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const work = yield* agent.get(AgentV2.ID.make("work"))
      expect(work).toBeDefined()
      expect(evaluate("task", "work", work!.permissions)).toBe("deny")
    }),
  )

  agentIt.effect("code cannot delegate to work or itself", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(code).toBeDefined()
      expect(evaluate("task", "work", code!.permissions)).toBe("deny")
      expect(evaluate("task", "code", code!.permissions)).toBe("deny")
    }),
  )

  // The real LSP tool is owned by opencode; Core only owns the agent policy.
  agentIt.effect("code has LSP permission and Work does not", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
      const work = yield* agent.get(AgentV2.ID.make("work"))
      const code = yield* agent.get(AgentV2.ID.make("code"))
      expect(work).toBeDefined()
      expect(code).toBeDefined()
      expect(evaluate("lsp", "*", work!.permissions)).toBe("deny")
      expect(evaluate("lsp", "*", code!.permissions)).toBe("allow")
    }),
  )

  agentIt.effect("existing agents retain their restrictions", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* loadAgents(agent)
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
})
