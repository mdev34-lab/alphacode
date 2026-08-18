# Tool Search Tool

Deferred tool loading for opencode, inspired by Anthropic's "Tool Search Tool" and the
[famitzsy8/opencode-tool-search-tool](https://github.com/famitzsy8/opencode-tool-search-tool) fork,
re-implemented for the current Effect-based architecture.

## Problem

Every tool definition (name + description + JSON schema) is sent to the model on every request.
With a handful of MCP servers connected this easily costs tens of thousands of tokens per turn,
before the conversation even starts. Most of those tools are never used in a given session.

## Solution

Keep a small set of *core* tools always loaded. Everything else is **deferred**: it lives in a
searchable catalog instead of the request payload. The model gets two cheap discovery tools:

- `tool_search` — BM25 keyword/semantic-ish search over tool names and descriptions.
- `tool_search_regex` — regex search over the same corpus, for precise lookups.

When a search returns hits, those tool IDs are recorded as *discovered* for that session. Tools are
resolved on every agent step, so discovered tools appear in the very next model call and stay
available for the rest of the session.

## Architecture

```
ToolCatalog (Effect service, instance-scoped state)
  ├─ entries: Entry[]          synced by SessionTools.resolve on every step
  ├─ index:   BM25.Index       rebuilt when the entry set changes
  └─ discovered: sessionID -> Set<toolID>

SessionTools.resolve
  1. build Entry[] from ToolRegistry.tools() + MCP.tools()
  2. mark each entry deferred/not per config
  3. catalog.sync(entries)
  4. skip deferred entries that the session has not discovered

tool_search / tool_search_regex
  → catalog.search / catalog.searchRegex
  → catalog.discover(sessionID, ids)
```

`ToolCatalog` deliberately does **not** depend on `ToolRegistry` or `MCP` — the caller pushes
entries in. That avoids a layer cycle (`registry -> tool_search -> catalog -> registry`) and keeps
the catalog trivially testable.

## Deferral policy

| Kind | Default |
| --- | --- |
| Core builtins (`shell`, `read`, `edit`, `write`, `apply_patch`, `glob`, `grep`, `todowrite`, `task`, `skill`, `question`, `invalid`, `plan_exit`, `execute`, `tool_search*`) | always loaded |
| Other builtins (`webfetch`, `websearch`, `lsp`) | deferred |
| Custom `.opencode/tool/*` and plugin tools | deferred |
| MCP tools | deferred |

Configurable via `tool_search` in `opencode.json`:

```jsonc
{
  "tool_search": {
    "enabled": true,          // false restores the classic "load everything" behaviour
    "always_load": ["github_*"], // wildcard patterns never deferred
    "defer": ["websearch"],      // extra wildcard patterns always deferred
    "limit": 5                   // max results per search
  }
}
```

## Plan (TDD)

1. `search/bm25.ts` — pure BM25 index/search. Tests first (`test/search/bm25.test.ts`).
2. `tool/catalog.ts` — pure deferral helpers (`resolveConfig`, `shouldDefer`) + `ToolCatalog`
   service (sync/search/searchRegex/get/discover/discovered/forget). Tests first
   (`test/tool/catalog.test.ts`).
3. `tool/tool-search.ts` + `tool/tool-search-regex.ts` with `.txt` descriptions, registered as
   builtins in `tool/registry.ts`.
4. `session/tools.ts` — build entries, sync catalog, filter deferred/undiscovered tools.
5. `core/v1/config/config.ts` — `tool_search` schema.
6. Docs: `packages/web/src/content/docs/docs/tools.mdx` (or config page) section.

## Verification

- `bun test test/search test/tool/catalog.test.ts test/tool/registry.test.ts`
- `bun turbo typecheck --filter=opencode`
- `bunx oxlint`
