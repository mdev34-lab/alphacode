import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ToolCatalog } from "./catalog"
import DESCRIPTION from "./tool-search.txt"

export const Categories = ["all", "builtin", "mcp"] as const

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "What the tool should be able to do, in keywords" }),
  category: Schema.optional(Schema.Literals(Categories)).annotate({
    description: "Restrict the search to a tool source. Defaults to all.",
  }),
})

export interface Metadata {
  query: string
  count: number
  tools: string[]
  [key: string]: unknown
}

export const ToolSearchTool = Tool.define(
  "tool_search",
  Effect.gen(function* () {
    const catalog = yield* ToolCatalog.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const source = params.category && params.category !== "all" ? params.category : undefined
          const results = yield* catalog.search(params.query, { source, session: ctx.sessionID })

          if (results.length === 0) return yield* nothingHidden(catalog, params.query, source, ctx.sessionID)

          const ids = results.map((entry) => entry.id)
          yield* catalog.discover(ctx.sessionID, ids)

          return {
            title: `Found ${results.length} ${results.length === 1 ? "tool" : "tools"}`,
            metadata: { query: params.query, count: results.length, tools: ids } satisfies Metadata,
            output: [
              "The following tools are now available to you:",
              "",
              ...results.map((entry) => describe(entry)),
            ].join("\n"),
          }
        }),
    }
  }),
)

/**
 * Nothing hidden matched. Before saying "no tools found", check whether the capability is
 * already loaded — telling the model "you already have `read`" is far more useful than
 * letting it conclude the capability does not exist.
 */
export function nothingHidden(
  catalog: ToolCatalog.Interface,
  query: string,
  source: ToolCatalog.Source | undefined,
  sessionID: string,
) {
  return Effect.gen(function* () {
    const loaded = yield* catalog.search(query, { source, session: sessionID, includeLoaded: true })
    const metadata = { query, count: 0, tools: [] } satisfies Metadata

    if (loaded.length === 0)
      return {
        title: "No tools found",
        metadata,
        output: `No tools found matching "${query}". Try different keywords, or tool_search_regex for a pattern match.`,
      }

    return { title: "Already available", metadata, output: alreadyAvailable(`"${query}"`, loaded) }
  })
}

/** Shared wording for "the capability exists, you just already have it" */
export function alreadyAvailable(label: string, loaded: ToolCatalog.Entry[]) {
  return [
    `No hidden tools matched ${label}. These tools are already available to you:`,
    "",
    ...loaded.map(describe),
  ].join("\n")
}

export function describe(entry: ToolCatalog.Entry) {
  const description = entry.description.split("\n")[0]?.trim() ?? ""
  const parameters = entry.parameters.length ? ` (${entry.parameters.join(", ")})` : ""
  return `- ${entry.id}${parameters}: ${description}`
}
