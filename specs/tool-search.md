# Tool Search Tool

Deferred tool loading for opencode, inspired by Anthropic's "Tool Search Tool" and the
[famitzsy8/opencode-tool-search-tool](https://github.com/famitzsy8/opencode-tool-search-tool) fork,
re-implemented for the current Effect-based architecture.

## Problem

Every tool definition (name + description + JSON schema) is sent to the model on every request.
With a handful of MCP servers connected this easily costs tens of thousands of tokens per turn,
before the conversation even starts. Most of those tools are never used in a given session.

## Solution

Keep a small set of _core_ tools always loaded. Everything else is **deferred**: it lives in a
searchable catalog instead of the request payload. The model gets two cheap discovery tools:

- `tool_search` — BM25 keyword/semantic-ish search over tool names and descriptions.
- `tool_search_regex` — regex search over the same corpus, for precise lookups.

When a search returns hits, those tool IDs are recorded as _discovered_ for that session. Tools are
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
  → catalog.search / catalog.searchRegex   (hidden tools only, by default)
  → catalog.discover(sessionID, ids)       (only ever unlocks a deferred tool)
```

Discovery is per session and dies with it: `ToolCatalog` listens for `session.deleted` and drops
that session's set, so a long-running server does not accumulate one `Set` per session that ever
ran a search.

`ToolCatalog` deliberately does **not** depend on `ToolRegistry` or `MCP` — the caller pushes
entries in. That avoids a layer cycle (`registry -> tool_search -> catalog -> registry`) and keeps
the catalog trivially testable.

## Deferral policy

| Kind                                                                                                                                                                         | Default       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Core builtins (`shell`, `read`, `edit`, `write`, `apply_patch`, `glob`, `grep`, `todowrite`, `task`, `skill`, `question`, `invalid`, `plan_exit`, `execute`, `tool_search*`) | always loaded |
| Other builtins (`webfetch`, `websearch`, `lsp`)                                                                                                                              | deferred      |
| Custom `.opencode/tool/*` and plugin tools                                                                                                                                   | deferred      |
| MCP tools                                                                                                                                                                    | deferred      |

Configurable via `tool_search` in `opencode.json`:

```jsonc
{
  "tool_search": {
    "enabled": true, // false restores the classic "load everything" behaviour
    "always_load": ["github_*"], // wildcard patterns never deferred
    "defer": ["websearch"], // extra wildcard patterns always deferred
    "limit": 5, // max results per search
  },
}
```

## Plan (TDD)

1. `search/bm25.ts` — pure BM25 index/search, Unicode tokenization, and agreement folding
   (regular plurals plus the `y`/`ie` family collapsed onto a common term; the result is not
   necessarily a real word). Tests first (`test/search/bm25.test.ts`).
2. `tool/catalog.ts` — pure deferral helpers (`options`, `deferred`) and the regex safety guard
   (`unsafePattern`) + `ToolCatalog` service (sync/search/searchRegex/get/discover/discovered/
   forget). `sync` carries the configured result limit and rebuilds the index every step —
   indexing a few hundred short documents is far cheaper than reasoning about staleness. Tests
   first (`test/tool/catalog.test.ts`, `test/tool/catalog-retrieval.test.ts`).
3. `tool/tool-search.ts` + `tool/tool-search-regex.ts` with `.txt` descriptions, registered as
   builtins in `tool/registry.ts`.
4. `session/tools.ts` — build entries, sync catalog, filter deferred/undiscovered tools.
5. `core/v1/config/config.ts` — `tool_search` schema.
6. Docs: `packages/web/src/content/docs/tools.mdx`, section "Tool search".

## Retrieval quality

With deferred loading, a false negative from the search is an invisible tool, so retrieval quality
is part of the agent's reliability. `test/tool/catalog-retrieval.test.ts` keeps a battery of
paraphrased capability queries ("open PR", "take screenshot", "query database", "run tests", …)
against a catalog written in the style of real MCP servers, asserting the expected tool lands in
the top 3. Add a case whenever a real-world query misses.

The same battery is measured as Recall@K, since `tool_search.limit` decides how deep the model
gets to look — a tool ranked #4 is invisible at limit 3. Current floors, enforced by the tests:

| K   | Recall                   |
| --- | ------------------------ |
| 1   | >= 80% (measured 86%)    |
| 3   | 100%                     |
| 5   | 100% (the default limit) |
| 10  | 100%                     |

## One corpus

Keyword and regex search read the same text, produced by a single `ToolCatalog.corpus(entry)`:
tool id, the first 2000 characters of the description, and parameter names. The keyword index is
built from it and the regex is tested against each field of it, so the two tools cannot
contradict each other about whether a tool matches. Fields stay separate so that an anchored
pattern like `^github_` still means "the id starts with".

## Discovery boundary

Being in the catalog and being discoverable are different things. `search` and `searchRegex`
return only entries with `deferred: true` unless the caller passes `includeLoaded`, and `discover`
silently drops anything that is not a deferred catalog entry. A search can therefore never grant
access to something the deferral policy did not hide in the first place, and a loaded tool never
consumes one of the `limit` result slots.

## Verification

- `bun test test/search test/tool/catalog.test.ts test/tool/catalog-retrieval.test.ts test/tool/registry.test.ts`
- `bun turbo typecheck --filter=opencode`
- `bunx oxlint`
