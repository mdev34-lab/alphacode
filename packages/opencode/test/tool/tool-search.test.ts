import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ToolCatalog } from "@/tool/catalog"
import { ToolSearchTool } from "@/tool/tool-search"
import { ToolSearchRegexTool } from "@/tool/tool-search-regex"
import { SessionID, MessageID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_search")

const ctx: Tool.Context = {
  sessionID,
  messageID: MessageID.make("msg_search"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const entries: ToolCatalog.Entry[] = [
  {
    id: "read",
    description: "Read the contents of a file from the filesystem",
    parameters: ["filePath"],
    source: "builtin",
    deferred: false,
  },
  {
    id: "github_list_issues",
    description: "List issues in a GitHub repository",
    parameters: ["owner", "repo"],
    source: "mcp",
    server: "github",
    deferred: true,
  },
  {
    id: "github_create_issue",
    description: "Create a new issue in a GitHub repository",
    parameters: ["owner", "repo", "title"],
    source: "mcp",
    server: "github",
    deferred: true,
  },
]

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolCatalog.node, Truncate.node, Agent.node])))

describe("tool.tool_search", () => {
  it.instance("returns matching tools and marks them discovered", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const tool = yield* Tool.init(yield* ToolSearchTool)
      const result = yield* tool.execute({ query: "find issues" }, ctx)

      expect(result.metadata.tools).toContain("github_list_issues")
      expect(result.output).toContain("github_list_issues")
      expect([...(yield* catalog.discovered(sessionID))]).toContain("github_list_issues")
    }),
  )

  it.instance("reports when nothing matches without discovering anything", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const tool = yield* Tool.init(yield* ToolSearchTool)
      const result = yield* tool.execute({ query: "kubernetes deployment rollout" }, ctx)

      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("No tools found")
      expect([...(yield* catalog.discovered(sessionID))]).toEqual([])
    }),
  )

  it.instance("respects the configured result limit", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries, ToolCatalog.options({ limit: 1 }))

      const tool = yield* Tool.init(yield* ToolSearchTool)
      const result = yield* tool.execute({ query: "github issue repository file" }, ctx)

      expect(result.metadata.tools).toHaveLength(1)
    }),
  )

  it.instance("filters by category", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const tool = yield* Tool.init(yield* ToolSearchTool)
      const result = yield* tool.execute({ query: "file repository", category: "builtin" }, ctx)

      expect(result.metadata.tools).toEqual(["read"])
    }),
  )
})

describe("tool.tool_search_regex", () => {
  it.instance("matches ids and descriptions case-insensitively", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const tool = yield* Tool.init(yield* ToolSearchRegexTool)
      const result = yield* tool.execute({ pattern: "github.*issue" }, ctx)

      expect([...(result.metadata.tools as string[])].sort()).toEqual(["github_create_issue", "github_list_issues"])
      expect([...(yield* catalog.discovered(sessionID))].sort()).toEqual(["github_create_issue", "github_list_issues"])
    }),
  )

  it.instance("explains an invalid pattern instead of failing", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const tool = yield* Tool.init(yield* ToolSearchRegexTool)
      const result = yield* tool.execute({ pattern: "(unclosed" }, ctx)

      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("Invalid regex")
    }),
  )
})
