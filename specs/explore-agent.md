# Explore Subagent Optimization

Optimizes the built-in `explore` subagent for **latency and token economy** with a high-signal, read-only-by-default context extraction approach.

## Problem

The existing `explore` agent prompt is a generic file-search specialist:

- Encourages broad file pattern matching and regex searches without batching guidance
- Previously allowed bash for directory listing (`find`, `grep`, `cat`) which is slower than native tools and breaks read-only semantics
- No explicit instruction to minimize agent turns or avoid redundant discovery
- Output guidance asks for absolute paths but does not constrain verbosity or forbid full file contents
- No structured handling for repository tasks
- Thoroughness levels mentioned in description (`quick`/`medium`/`very thorough`) are not defined in the prompt itself
- Permission set included `webfetch`/`websearch` without gating, allowing high-latency external calls for local codebase questions

Result: higher latency, higher token usage, noisy outputs, and a security-semantics mismatch (read-only claim with arbitrary shell).

## Solution

Replace the explore agent's definition with a **fast, read-only-by-default context extraction** approach optimized for high signal, low latency, minimal output, with hard read-only permissions.

### Identity

- **Description:** Fast, read-only by default agent for extracting relevant context from available sources. Read-only by default, not a hard sandbox — user permission config can override via `Permission.merge` + `findLast` (repository-wide behavior).
- **Mode:** subagent
- **Permissions (deny-by-default, true read-only):**
  - `read: allow`
  - `grep: allow`
  - `glob: allow`
  - `list: allow`
  - `webfetch: allow` (gated: only for external context)
  - `bash: deny` (mirrors `review` agent — no arbitrary shell; preserves read-only semantics)
  - `websearch: deny` (high latency, gated)
  - `write: deny`
  - `edit: deny`
  - `task: deny`
  - `todowrite: deny`
  - `memory_write: deny`
  - `memory_forget: deny`
  - `external_directory: readonlyExternalDirectory`

Actual implementation:

```ts
"*": "deny",
grep: "allow",
glob: "allow",
list: "allow",
read: "allow",
webfetch: "allow", // gated in prompt
bash: "deny",
websearch: "deny",
write: "deny",
edit: "deny",
task: "deny",
todowrite: "deny",
memory_write: "deny",
memory_forget: "deny",
external_directory: readonlyExternalDirectory
```

This matches `review` agent's read-only pattern (which also denies bash) and fixes the contradiction: read-only agent cannot have general-purpose shell.

### Role Prompt

```
You are `explore`, a read-only by default context extraction agent.

Find and return relevant information from available project and context sources. Optimize for high signal, low latency, and minimal output.

You are read-only by default: do not edit, write, or delete files, do not run shell commands that modify state, and do not dispatch subagents. User permission config can override defaults (repository-wide behavior via Permission.merge with findLast), so treat this as a policy, not a hard sandbox.
```

### Execution Guidelines

- Batch independent tool calls whenever possible.
- Minimize agent turns.
- Prefer direct reads when the target is known.
- Avoid redundant discovery or repeated tool calls.
- Read likely entry-point files early when their names are known.
- Use native file-discovery tools (Glob, Grep, List, Read) instead of shell directory-listing commands.
- For repository introspection, prefer native tools and structured history APIs over bash. Bash is denied for this agent to preserve read-only semantics (mirrors review agent).
- Do not grep/glob the filesystem root unless required.
- Do not modify files.
- Web tools gated: use webfetch/websearch only when requested context is external to the repository or caller explicitly asks for web research. For local codebase questions, never use web tools — they burn latency and tokens. websearch denied by default; webfetch allowed only for external context.
- Thoroughness adaptation:
  - quick: 1-2 targeted patterns, direct read if known, immediate synthesis.
  - medium: multiple patterns, follow imports/entry points, batch reads of top candidates.
  - very thorough: comprehensive across naming conventions, check tests/docs/configs, still batched and concise.

Latency wins:
- Batching reduces round-trips.
- Direct reads avoid expensive broad searches.
- Native tools faster than `find`/`ls` via bash and have structured outputs.
- Denying websearch eliminates high-latency external calls for local questions.

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

Token economy: parent agent receives exactly what it needs to decide next, without paying for duplicated file dumps.

### Permission Override Semantics

`Permission.evaluate()` uses `findLast`, and `Permission.merge()` concatenates rules as `merge(defaults, exploreRules, user)`. So `user` comes last and can override explore defaults. This is intentional repository-wide behavior, not a bug. Therefore the agent is described as **read-only by default**, not absolute sandbox. If product semantics require hard sandbox, a separate enforcement layer is needed outside agent definition.

### Thoroughness Levels

Description advertises `quick`/`medium`/`very thorough` for caller control, now defined in prompt with latency-aware workflow (see Execution).

### Verification

- `cd packages/opencode && bun test test/agent/agent.test.ts` — explore denies edit/write/todowrite/bash/websearch, allows read/grep/glob/list/webfetch. Expected to pass.
- `bun turbo typecheck --filter=opencode` or `tsc --noEmit` with increased heap — no type errors in agent.ts.
- Manual: invoke explore subagent with codebase question, verify output is concise, contains absolute paths, no full file contents, completes in minimal turns, no bash usage, no websearch.
- GitHub CI: `pr-standards` workflow must succeed (conventional title, template sections, checklist).
- Review feedback addressed: bash contradiction resolved (deny), web tools gated (websearch deny + prompt gating), read-only-by-default clarified, permission override semantics documented.

## Architecture

- `packages/opencode/src/agent/prompt/explore.txt` — new prompt implementing Role/Execution/Output with bash denial and web-tool gating
- `packages/opencode/src/agent/agent.ts` — updated description to "Fast, read-only by default..." and permission set: deny bash/websearch, allow webfetch gated, explicit denies for write/edit/task/todowrite/memory_write/memory_forget
- Spec file `specs/explore-agent.md` (this file) documents approach and review fixes

No new dependencies, no schema changes. Aligns with `review` agent's read-only pattern.
