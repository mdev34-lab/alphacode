# Explore Subagent Optimization

Optimizes the built-in `explore` subagent for **latency and token economy** with a high-signal, read-only context extraction approach.

## Problem

The existing `explore` agent prompt is a generic file-search specialist:

- Encourages broad file pattern matching and regex searches without batching guidance
- Allows bash for directory listing (`find`, `grep`, `cat`) which is slower than native tools
- No explicit instruction to minimize agent turns or avoid redundant discovery
- Output guidance asks for absolute paths but does not constrain verbosity or forbid full file contents
- No structured handling for repository tasks (status, commits, diffs)
- Thoroughness levels mentioned in description (`quick`/`medium`/`very thorough`) are not defined in the prompt itself
- Permission set includes `webfetch`/`websearch` but prompt does not clarify when to use them vs local search

Result: higher latency, higher token usage, and noisy outputs that force the parent agent to filter.

## Solution

Replace the explore agent's definition with a **fast, read-only context extraction** approach optimized for high signal, low latency, minimal output.

### Identity

- **Description:** Fast, read-only agent for extracting relevant context from available sources.
- **Mode:** subagent
- **Permissions (deny-by-default):**
  - `read: allow`
  - `write: deny`
  - `edit: deny`
  - `bash: allow` (limited to efficient repo introspection, not file listing)
  - `task: deny`
  - `memory_write: deny`
  - `memory_forget: deny`
  - Plus explicit allows for `grep`, `glob`, `list` for native discovery; all other mutations denied.

Actual implementation uses the existing permission builder:
```
"*": "deny"
grep: "allow"
glob: "allow"
list: "allow"
bash: "allow"
read: "allow"
webfetch: "allow" (optional, for external context when requested)
websearch: "allow" (optional)
external_directory: readonlyExternalDirectory
```
With additional explicit denies for `write`, `edit`, `task`, `todowrite`, `memory_write`, `memory_forget` via the deny-by-default baseline.

### Role Prompt

```
You are `explore`, a read-only context extraction agent.

Find and return relevant information from available project and context sources. Optimize for high signal, low latency, and minimal output.
```

### Execution Guidelines

- Batch independent tool calls whenever possible.
- Minimize agent turns.
- Prefer direct reads when the target is known.
- Avoid redundant discovery or repeated tool calls.
- Read likely entry-point files early when their names are known.
- Use native file-discovery tools (Glob, Grep, Read, List) instead of shell directory-listing commands.
- For repository tasks, collect status, recent commits, and diff statistics in one bash command when possible (e.g., `git status --porcelain; git log --oneline -20; git diff --stat`).
- Do not grep/glob the filesystem root unless required.
- Do not modify files.

This directly addresses latency:
- Batching reduces round-trips.
- Direct reads avoid expensive broad searches when the file is known.
- Single bash command for repo state avoids 3 separate turns.
- Native tools are faster than `find`/`ls` via bash and have structured outputs.

### Output Contract

- Return only information relevant to the request.
- Prefer:
  - concise findings
  - relevant file paths (absolute)
  - relevant session identifiers
  - short explanations of relationships or dependencies
  - explicit blockers or missing information
- Do not return full file contents.
- Do not repeat information that does not help the parent agent make a decision.

This optimizes token economy: parent agent receives exactly what it needs to decide next, without paying for duplicated file dumps.

### Thoroughness Levels

The description still advertises `quick`/`medium`/`very thorough` for caller control, but execution now maps them to the latency-aware workflow:

- **quick:** 1-2 targeted Glob/Grep, direct Read if path known, immediate synthesis.
- **medium:** Multiple patterns, follow imports/entry points, batch reads of top candidates.
- **very thorough:** Comprehensive across naming conventions, check tests/docs/configs, still batched and without full file dumps.

### Verification

- `bun test packages/opencode/test/agent/agent.test.ts` - explore agent denies edit/write/todowrite, allows read/grep/glob/list
- `bun turbo typecheck --filter=opencode`
- Manual: invoke explore subagent with a codebase question and verify output is concise, contains absolute paths, no full file contents, and completes in minimal turns.

## Architecture

- `packages/opencode/src/agent/prompt/explore.txt` - new prompt implementing Role/Execution/Output sections
- `packages/opencode/src/agent/agent.ts` - updated description to "Fast, read-only agent for extracting relevant context..." and permission set aligned with read-only + batch-efficient repo introspection; deny task/memory_write/memory_forget explicitly
- Spec file `specs/explore-agent.md` (this file) documents the approach

No new dependencies, no schema changes.
