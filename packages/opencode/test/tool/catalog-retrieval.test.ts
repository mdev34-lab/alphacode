import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolCatalog } from "@/tool/catalog"
import { testEffect } from "../lib/effect"

/**
 * Retrieval quality battery.
 *
 * With deferred loading a false negative from the search is, in practice, an invisible tool.
 * These cases are paraphrases of what an agent actually types, matched against descriptions
 * written in the style of real MCP servers.
 */

const it = testEffect(LayerNode.compile(ToolCatalog.node))

const tool = (id: string, description: string, source: ToolCatalog.Source = "mcp"): ToolCatalog.Entry => ({
  id,
  description,
  parameters: [],
  source,
  deferred: source === "mcp",
})

const catalogEntries: ToolCatalog.Entry[] = [
  tool("read", "Read the contents of a file from the filesystem", "builtin"),
  tool("write", "Write content to a file, creating it if it does not exist", "builtin"),
  tool("grep", "Search file contents for a regular expression across the project", "builtin"),
  tool("shell", "Run a shell command in the project directory", "builtin"),
  tool("webfetch", "Fetch a URL and return its contents as text, markdown or html", "builtin"),
  tool("github_create_pull_request", "Create a new pull request (PR) in a GitHub repository"),
  tool("github_list_pull_requests", "List pull requests (PRs) in a GitHub repository"),
  tool("github_list_issues", "List issues in a GitHub repository, filtered by state, label or assignee"),
  tool("github_create_issue", "Create a new issue in a GitHub repository"),
  tool("github_merge_pull_request", "Merge an open pull request in a GitHub repository"),
  tool("linear_search_issues", "Search Linear issues and tickets by keyword, team or status"),
  tool("whatsapp_send_message", "Send a WhatsApp message to a contact or group chat"),
  tool("slack_post_message", "Post a message to a Slack channel or direct message conversation"),
  tool("playwright_screenshot", "Take a screenshot of the current browser page and return it as an image"),
  tool("playwright_snapshot", "Inspect the browser page and return an accessibility snapshot of the DOM"),
  tool("playwright_click", "Click an element on the current browser page"),
  tool("postgres_query", "Run a read-only SQL query against the connected PostgreSQL database"),
  tool("postgres_list_tables", "List the tables and schemas available in the connected database"),
  tool("context7_search_docs", "Search library documentation and return the matching pages"),
  tool("image_edit", "Edit or transform an image: crop, resize, rotate and apply filters"),
  tool("image_generate", "Generate a new image from a text prompt"),
  tool("vitest_run", "Run the project test suite with vitest and report failing tests"),
  tool("sentry_list_issues", "List error events and issues reported to Sentry for a project"),
  tool("stripe_create_refund", "Create a refund for a Stripe payment or charge"),
  tool("notion_search", "Search Notion pages and databases by keyword"),
]

const cases: { query: string; expect: string }[] = [
  { query: "open PR", expect: "github_create_pull_request" },
  { query: "create a pull request", expect: "github_create_pull_request" },
  { query: "look at GitHub issues", expect: "github_list_issues" },
  { query: "list open issues in the repo", expect: "github_list_issues" },
  { query: "send message on WhatsApp", expect: "whatsapp_send_message" },
  { query: "post to slack", expect: "slack_post_message" },
  { query: "take screenshot", expect: "playwright_screenshot" },
  { query: "capture the page as an image", expect: "playwright_screenshot" },
  { query: "inspect browser", expect: "playwright_snapshot" },
  { query: "query database", expect: "postgres_query" },
  { query: "run a sql query", expect: "postgres_query" },
  { query: "what tables exist in the database", expect: "postgres_list_tables" },
  { query: "search documentation", expect: "context7_search_docs" },
  { query: "modify image", expect: "image_edit" },
  { query: "resize a picture", expect: "image_edit" },
  { query: "run tests", expect: "vitest_run" },
  { query: "check production errors", expect: "sentry_list_issues" },
  { query: "refund a payment", expect: "stripe_create_refund" },
  { query: "search linear tickets", expect: "linear_search_issues" },
  { query: "read a file", expect: "read" },
  { query: "fetch a webpage", expect: "webfetch" },
]

describe("ToolCatalog retrieval quality", () => {
  for (const item of cases) {
    it.instance(`"${item.query}" finds ${item.expect}`, () =>
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        yield* catalog.sync(catalogEntries)

        const results = yield* catalog.search(item.query, { limit: 3 })
        expect(results.map((entry) => entry.id)).toContain(item.expect)
      }),
    )
  }

  // The ranking must not change shape with the limit: a smaller limit is a prefix of a
  // bigger one, never a different set. This is what makes tool_search.limit safe to tune.
  for (const limit of [1, 3, 5]) {
    it.instance(`limit ${limit} returns the top ${limit} of the full ranking`, () =>
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        yield* catalog.sync(catalogEntries)

        const full = yield* catalog.search("github issue repository", { limit: catalogEntries.length })
        const limited = yield* catalog.search("github issue repository", { limit })

        expect(limited).toHaveLength(Math.min(limit, full.length))
        expect(limited.map((entry) => entry.id)).toEqual(full.slice(0, limit).map((entry) => entry.id))
      }),
    )
  }

  // Recall@K, because `tool_search.limit` is the knob that decides how deep the model gets to
  // look. A tool ranked #4 is invisible at limit 3. These floors are the contract for the
  // default limit of 5; if a change drops them, the deferred tools stop being findable.
  const floors: Record<number, number> = { 1: 0.8, 3: 1, 5: 1, 10: 1 }

  for (const [k, floor] of Object.entries(floors)) {
    it.instance(`recall@${k} is at least ${(floor * 100).toFixed(0)}%`, () =>
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        yield* catalog.sync(catalogEntries)

        const misses: string[] = []
        for (const item of cases) {
          const results = yield* catalog.search(item.query, { limit: Number(k) })
          if (!results.some((entry) => entry.id === item.expect)) misses.push(item.query)
        }

        const recall = (cases.length - misses.length) / cases.length
        // Name the misses in the failure output, otherwise a regression is just a number
        if (recall < floor) throw new Error(`recall@${k} = ${recall.toFixed(2)}, missed: ${misses.join(" | ")}`)
        expect(recall).toBeGreaterThanOrEqual(floor)
      }),
    )
  }
})
