import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Data, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { BM25 } from "@/search/bm25"
import { Wildcard } from "@/util/wildcard"

/**
 * Catalog of every tool the current agent could use, including the ones that are
 * withheld from the model until it discovers them with `tool_search`.
 *
 * The catalog is intentionally passive: `SessionTools.resolve` pushes the current
 * entries in on every step. Keeping the dependency arrow pointing that way avoids a
 * layer cycle (registry -> tool_search -> catalog -> registry) and makes the catalog
 * trivially testable.
 */

export type Source = "builtin" | "mcp"

export interface Entry {
  id: string
  description: string
  parameters: string[]
  source: Source
  /** MCP server name, when the tool comes from an MCP server */
  server?: string
  /** Withheld from the model until discovered through a tool search */
  deferred: boolean
}

export interface Options {
  enabled: boolean
  alwaysLoad: string[]
  defer: string[]
  limit: number
}

export interface SearchOptions {
  limit?: number
  source?: Source
}

export class InvalidPatternError extends Data.TaggedError("ToolCatalog.InvalidPatternError")<{
  pattern: string
  detail: string
}> {
  override get message() {
    return `Invalid regex pattern "${this.pattern}": ${this.detail}`
  }
}

/** Maximum number of results a single search returns unless configured otherwise */
export const DEFAULT_LIMIT = 5

/**
 * Tools that stay in every request. These are the ones an agent needs to do basic work
 * (and to search for everything else) — deferring them would just cost an extra round trip.
 */
export const CORE_TOOLS = [
  "invalid",
  "tool_search",
  "tool_search_regex",
  "shell",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "todoread",
  "task",
  "skill",
  "question",
  "plan_exit",
  "execute",
] as const

const CORE = new Set<string>(CORE_TOOLS)

export function options(config: ConfigV1.Info["tool_search"]): Options {
  return {
    enabled: config?.enabled ?? true,
    alwaysLoad: config?.always_load ?? [],
    defer: config?.defer ?? [],
    limit: config?.limit ?? DEFAULT_LIMIT,
  }
}

function matches(id: string, patterns: string[]) {
  return patterns.some((pattern) => Wildcard.match(id, pattern))
}

/** Should this tool be withheld from the model until it is discovered? */
export function deferred(input: { id: string; source: Source; options: Options }): boolean {
  if (!input.options.enabled) return false
  if (matches(input.id, input.options.alwaysLoad)) return false
  if (matches(input.id, input.options.defer)) return true
  if (input.source === "mcp") return true
  return !CORE.has(input.id)
}

type State = {
  entries: Entry[]
  index: BM25.Index<Entry> | undefined
  discovered: Map<string, Set<string>>
}

export interface Interface {
  /** Replace the catalog contents. Called once per agent step. */
  readonly sync: (entries: Entry[]) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Entry[]>
  readonly get: (id: string) => Effect.Effect<Entry | undefined>
  readonly search: (query: string, options?: SearchOptions) => Effect.Effect<Entry[]>
  readonly searchRegex: (pattern: string, options?: SearchOptions) => Effect.Effect<Entry[], InvalidPatternError>
  readonly discover: (sessionID: string, ids: string[]) => Effect.Effect<void>
  readonly discovered: (sessionID: string) => Effect.Effect<ReadonlySet<string>>
  readonly forget: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolCatalog") {}

export const use = serviceUse(Service)

const EMPTY: ReadonlySet<string> = new Set<string>()

function signature(entries: Entry[]) {
  return entries.map((entry) => `${entry.id}\u0000${entry.description.length}`).join("\u0001")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolCatalog.state")(() =>
        Effect.succeed<State>({ entries: [], index: undefined, discovered: new Map() }),
      ),
    )

    const sync: Interface["sync"] = Effect.fn("ToolCatalog.sync")(function* (entries) {
      const s = yield* InstanceState.get(state)
      if (s.index && signature(s.entries) === signature(entries)) {
        s.entries = entries
        return
      }
      s.entries = entries
      s.index = BM25.createIndex(entries, (entry) => [entry.id, entry.description])
    })

    const list: Interface["list"] = Effect.fn("ToolCatalog.list")(function* () {
      return (yield* InstanceState.get(state)).entries
    })

    const get: Interface["get"] = Effect.fn("ToolCatalog.get")(function* (id) {
      return (yield* InstanceState.get(state)).entries.find((entry) => entry.id === id)
    })

    const search: Interface["search"] = Effect.fn("ToolCatalog.search")(function* (query, options) {
      const s = yield* InstanceState.get(state)
      if (!s.index) return []
      return BM25.search(s.index, query, s.entries.length)
        .map((result) => result.item)
        .filter((entry) => !options?.source || entry.source === options.source)
        .slice(0, options?.limit ?? DEFAULT_LIMIT)
    })

    const searchRegex: Interface["searchRegex"] = Effect.fn("ToolCatalog.searchRegex")(function* (pattern, options) {
      const s = yield* InstanceState.get(state)
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern, "i"),
        catch: (error) =>
          new InvalidPatternError({ pattern, detail: error instanceof Error ? error.message : String(error) }),
      })
      return s.entries
        .filter((entry) => !options?.source || entry.source === options.source)
        .filter((entry) => regex.test(entry.id) || regex.test(entry.description))
        .slice(0, options?.limit ?? DEFAULT_LIMIT)
    })

    const discover: Interface["discover"] = Effect.fn("ToolCatalog.discover")(function* (sessionID, ids) {
      const s = yield* InstanceState.get(state)
      const existing = s.discovered.get(sessionID) ?? new Set<string>()
      for (const id of ids) existing.add(id)
      s.discovered.set(sessionID, existing)
    })

    const discovered: Interface["discovered"] = Effect.fn("ToolCatalog.discovered")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      return s.discovered.get(sessionID) ?? EMPTY
    })

    const forget: Interface["forget"] = Effect.fn("ToolCatalog.forget")(function* (sessionID) {
      const s = yield* InstanceState.get(state)
      s.discovered.delete(sessionID)
    })

    return Service.of({ sync, list, get, search, searchRegex, discover, discovered, forget })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as ToolCatalog from "./catalog"
