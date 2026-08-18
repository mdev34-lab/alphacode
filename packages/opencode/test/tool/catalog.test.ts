import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolCatalog } from "@/tool/catalog"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(ToolCatalog.node))

const entry = (input: Partial<ToolCatalog.Entry> & { id: string }): ToolCatalog.Entry => ({
  description: "",
  parameters: [],
  source: "builtin",
  deferred: true,
  ...input,
})

const entries: ToolCatalog.Entry[] = [
  entry({ id: "read", description: "Read the contents of a file from the filesystem", deferred: false }),
  entry({ id: "glob", description: "Find files by name pattern in a directory", deferred: false }),
  entry({
    id: "github_list_issues",
    description: "List issues in a GitHub repository",
    source: "mcp",
    server: "github",
    parameters: ["owner", "repo"],
  }),
  entry({
    id: "github_create_issue",
    description: "Create a new issue in a GitHub repository",
    source: "mcp",
    server: "github",
  }),
  entry({ id: "linear_search", description: "Search Linear tickets by keyword", source: "mcp", server: "linear" }),
]

describe("ToolCatalog.options", () => {
  it.effect("defaults to enabled with the default limit", () =>
    Effect.sync(() => {
      const options = ToolCatalog.options(undefined)
      expect(options.enabled).toBe(true)
      expect(options.limit).toBe(ToolCatalog.DEFAULT_LIMIT)
      expect(options.alwaysLoad).toEqual([])
      expect(options.defer).toEqual([])
    }),
  )

  it.effect("reads user overrides", () =>
    Effect.sync(() => {
      const options = ToolCatalog.options({
        enabled: false,
        always_load: ["github_*"],
        defer: ["read"],
        limit: 12,
      })
      expect(options).toEqual({ enabled: false, alwaysLoad: ["github_*"], defer: ["read"], limit: 12 })
    }),
  )
})

describe("ToolCatalog.deferred", () => {
  const options = ToolCatalog.options(undefined)

  it.effect("never defers core builtin tools", () =>
    Effect.sync(() => {
      for (const id of ToolCatalog.CORE_TOOLS) {
        expect(ToolCatalog.deferred({ id, source: "builtin", options })).toBe(false)
      }
    }),
  )

  it.effect("defers non-core builtin tools", () =>
    Effect.sync(() => {
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options })).toBe(true)
      expect(ToolCatalog.deferred({ id: "my_custom_tool", source: "builtin", options })).toBe(true)
    }),
  )

  it.effect("defers mcp tools", () =>
    Effect.sync(() => {
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options })).toBe(true)
    }),
  )

  it.effect("defers nothing when disabled", () =>
    Effect.sync(() => {
      const disabled = ToolCatalog.options({ enabled: false })
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options: disabled })).toBe(false)
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options: disabled })).toBe(false)
    }),
  )

  it.effect("honours always_load wildcard patterns", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ always_load: ["github_*"] })
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options: custom })).toBe(false)
      expect(ToolCatalog.deferred({ id: "linear_search", source: "mcp", options: custom })).toBe(true)
    }),
  )

  it.effect("honours defer patterns for core tools", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ defer: ["read"] })
      expect(ToolCatalog.deferred({ id: "read", source: "builtin", options: custom })).toBe(true)
    }),
  )

  it.effect("always_load wins over defer", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ always_load: ["websearch"], defer: ["web*"] })
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options: custom })).toBe(false)
    }),
  )
})

describe("ToolCatalog service", () => {
  it.instance("returns nothing before any sync", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      expect(yield* catalog.list()).toEqual([])
      expect(yield* catalog.search("file")).toEqual([])
      expect(yield* catalog.get("read")).toBeUndefined()
    }),
  )

  it.instance("ranks tools by relevance to the query", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const results = yield* catalog.search("github issues")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe("github_list_issues")
      expect(results.map((r) => r.id)).toContain("github_create_issue")
      expect(results.map((r) => r.id)).not.toContain("read")
    }),
  )

  it.instance("limits results and filters by source", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      expect(yield* catalog.search("issue repository", { limit: 1 })).toHaveLength(1)

      const builtin = yield* catalog.search("file", { source: "builtin" })
      expect(builtin.length).toBeGreaterThan(0)
      expect(builtin.every((item) => item.source === "builtin")).toBe(true)

      expect(yield* catalog.search("file", { source: "mcp" })).toEqual([])
    }),
  )

  it.instance("searches by regex over id and description", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const results = yield* catalog.searchRegex("github.*issue")
      expect(results.map((r) => r.id).sort()).toEqual(["github_create_issue", "github_list_issues"])

      expect((yield* catalog.searchRegex("^linear")).map((r) => r.id)).toEqual(["linear_search"])
      expect(yield* catalog.searchRegex("ISSUES")).not.toHaveLength(0)
    }),
  )

  it.instance("fails on an invalid regex", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const result = yield* catalog.searchRegex("(unclosed").pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }),
  )

  it.instance("tracks discovered tools per session", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const one = SessionID.make("ses_one")
      const two = SessionID.make("ses_two")

      expect([...(yield* catalog.discovered(one))]).toEqual([])

      yield* catalog.discover(one, ["github_list_issues"])
      yield* catalog.discover(one, ["github_list_issues", "linear_search"])
      expect([...(yield* catalog.discovered(one))].sort()).toEqual(["github_list_issues", "linear_search"])
      expect([...(yield* catalog.discovered(two))]).toEqual([])

      yield* catalog.forget(one)
      expect([...(yield* catalog.discovered(one))]).toEqual([])
    }),
  )

  it.instance("replaces the index when the catalog is re-synced", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)
      yield* catalog.sync([entry({ id: "notion_page", description: "Read a Notion page", source: "mcp" })])

      expect(yield* catalog.get("github_list_issues")).toBeUndefined()
      expect((yield* catalog.search("notion")).map((r) => r.id)).toEqual(["notion_page"])
      expect(yield* catalog.list()).toHaveLength(1)
    }),
  )
})
