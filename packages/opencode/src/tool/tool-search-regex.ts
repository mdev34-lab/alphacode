import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ToolCatalog } from "./catalog"
import { alreadyAvailable, Categories, describe as describeEntry, type Metadata } from "./tool-search"
import DESCRIPTION from "./tool-search-regex.txt"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Regex matched against tool names and descriptions" }),
  category: Schema.optional(Schema.Literals(Categories)).annotate({
    description: "Restrict the search to a tool source. Defaults to all.",
  }),
})

export const ToolSearchRegexTool = Tool.define(
  "tool_search_regex",
  Effect.gen(function* () {
    const catalog = yield* ToolCatalog.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const source = params.category && params.category !== "all" ? params.category : undefined
          const results = yield* catalog.searchRegex(params.pattern, { source }).pipe(Effect.result)

          if (results._tag === "Failure")
            return {
              title: "Invalid regex",
              metadata: { query: params.pattern, count: 0, tools: [] } satisfies Metadata,
              output: `Invalid regex pattern "${params.pattern}". Rewrite it as a valid JavaScript regular expression.`,
            }

          const matched = results.success
          if (matched.length === 0) {
            const loaded = yield* catalog
              .searchRegex(params.pattern, { source, includeLoaded: true })
              .pipe(Effect.orElseSucceed(() => []))
            const metadata = { query: params.pattern, count: 0, tools: [] } satisfies Metadata
            if (loaded.length === 0)
              return {
                title: "No tools found",
                metadata,
                output: `No tools found matching /${params.pattern}/i. Try a looser pattern, or tool_search for a keyword search.`,
              }
            return {
              title: "Already available",
              metadata,
              output: alreadyAvailable(`/${params.pattern}/i`, loaded),
            }
          }

          const ids = matched.map((entry) => entry.id)
          yield* catalog.discover(ctx.sessionID, ids)

          return {
            title: `Found ${matched.length} ${matched.length === 1 ? "tool" : "tools"}`,
            metadata: { query: params.pattern, count: matched.length, tools: ids } satisfies Metadata,
            output: ["The following tools are now available to you:", "", ...matched.map(describeEntry)].join("\n"),
          }
        }),
    }
  }),
)
