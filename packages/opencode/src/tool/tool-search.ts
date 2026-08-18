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
          const results = yield* catalog.search(params.query, {
            source: params.category && params.category !== "all" ? params.category : undefined,
          })

          if (results.length === 0)
            return {
              title: "No tools found",
              metadata: { query: params.query, count: 0, tools: [] } satisfies Metadata,
              output: `No tools found matching "${params.query}". Try different keywords, or tool_search_regex for a pattern match.`,
            }

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

export function describe(entry: ToolCatalog.Entry) {
  const description = entry.description.split("\n")[0]?.trim() ?? ""
  const parameters = entry.parameters.length ? ` (${entry.parameters.join(", ")})` : ""
  return `- ${entry.id}${parameters}: ${description}`
}
