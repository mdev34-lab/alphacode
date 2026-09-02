# Dynamic Context Management

Native context engineering for AlphaCode sessions: the provider context is compiled from canonical
history on every turn instead of being mutated in place. Inspired by the Dynamic Context Plugin
(DCP), re-implemented against the Effect-based V2 session runtime.

## Problem

A long session sends the same bytes to the provider again and again: repeated `read` of the same
file, the full input of a command that failed twenty turns ago, exploration that is finished and no
longer load-bearing. Native compaction only helps at the very end, by discarding everything at once.

## Solution

Keep the session history immutable and treat "what we send to the model" as a compiled artifact.
Between `SessionHistory.entriesForRunner` and `toLLMMessages`, `ContextManager.prepare` runs a
deterministic pipeline over canonical `SessionMessage.Message[]`:

```
canonical history + request envelope
  → compression placeholders   (ContextPlaceholder.apply)
  → duplicate tool output      (ContextDeduplicate)
  → stale failed tool inputs   (ContextPurgeErrors)
  → protection policy          (ContextProtection)
  → measurement + budget bands (ContextBudget)
  → payload-byte fallback      (ContextBudget.reduce)
  → invariant check            (ContextInvariants)
  → provider request
```

### Measuring the whole request

Utilization is measured over the **prompt envelope**, not just the message list. The session runner
declares what the same request will carry besides history — the assembled system prompt, the tool
definitions, and request-level extras such as the max-steps prompt — as `prepare({ envelope })`, and
`ContextBudget.envelope` measures it exactly the way history is measured. `overheadTokens` is
reported in the prepared stats, the `session.next.context.prepared` event, and
`GET /api/session/:id/context/stats`, and the same figure is subtracted from `context.payload_bytes`
before the byte ladder runs. Without this a session with a large toolset believes it is at 70% while
the provider sees 95%.

The last declared envelope is remembered per session so a stats request between turns still reports
against the real request rather than the history alone.

Every stage is pure and monotonic: once a call is superseded or an error input is stale, it stays
that way. The request prefix therefore only changes when something genuinely new happens, which
keeps provider prompt caching useful.

### Runtime cost

`prepare` runs before every provider request, so the case that matters is the one where nothing
needs reducing. `packages/core/script/context-benchmark.ts` measures exactly that — no compression
blocks, no duplicates, no stale failures — and reports, on a development machine:

| History        | Serialized | Preparation |
| -------------- | ---------- | ----------- |
| 100 messages   | 62 KiB     | ~1.4 ms     |
| 500 messages   | 313 KiB    | ~4.2 ms     |
| 2,000 messages | 1.2 MiB    | ~16.6 ms    |

The curve is linear in serialized history size, and serialization dominates it: `ContextBudget.measure`
returns tokens and bytes from a single `JSON.stringify` so the pipeline serializes each list once.
Against a provider request measured in seconds this is noise, but it is measured rather than assumed,
and the script is committed so a regression is one command away.

What is remembered between turns is the reduction _decision_, not the projection. Caching a
projection would be unsound — the message list differs on every turn — while remembering the plan
keeps repeated reads (`stats`, the TUI indicator) free and keeps the revision, and therefore the
provider prompt prefix, stable when nothing has changed.

## Hard rules

These are enforced by `ContextInvariants.check`, which runs on every prepared context. A violation
logs `context.prepare.invariant` and falls back to the canonical passthrough context — context
management can never make a session unusable.

1. **No synthetic assistant content.** The compiler never fabricates assistant messages, assistant
   text, or tool calls, and never rewrites model text.
2. **No appended system messages.** At most one logical system prompt exists, assembled once at
   request construction: `[agent prompt, context guidance, baseline system context]`.
3. **Canonical history is immutable.** Only the provider projection changes; `session.messages`
   always returns the original content.
4. **Tool calls stay paired.** `ContextInvariants.pairing` runs on the _lowered_ message list
   immediately before the request is built: every tool call must be answered by the messages that
   follow it, and no result may answer nothing. Providers express this differently — `tool_calls`
   and `tool` messages, `tool_use` and `tool_result` blocks, `functionCall` and `functionResponse`
   parts — so it is checked once, provider-independently, rather than left as an incidental
   property of canonical message shape. A reduction that would break the pairing loses to the
   canonical history, unless the canonical history was itself already unpaired, since falling back
   cannot repair what was already broken.

Editing recorded tool _results_ and stale failed tool _inputs_ is allowed — those are AlphaCode's
own recordings, not model output — but only through the four transformations this subsystem owns:
the duplicate marker, the purged-input marker, the payload-budget truncation, and the superseded
todo marker. `ContextInvariants` recognizes each of them from the canonical part it replaced; any
other edit to a recorded call counts as fabrication. Message order is checked too: reduction may
remove and summarize messages, never resequence them.

## Modules (`packages/core/src/context/`)

| Module              | Responsibility                                                             |
| ------------------- | -------------------------------------------------------------------------- |
| `manager.ts`        | `prepare`, `compress`, `stats`, `invalidate`, `guidance`; event publishing |
| `compressor.ts`     | Summary prompt construction and block creation                             |
| `deduplicate.ts`    | Plan/apply superseded duplicate tool output                                |
| `purge-errors.ts`   | Plan/apply stale failed tool inputs                                        |
| `protection.ts`     | Protected tools, file globs, recent turns, message types                   |
| `budget.ts`         | Token measurement, threshold bands, payload-byte reduction ladder          |
| `placeholders.ts`   | Deterministic compression placeholders, nesting, stale-block detection     |
| `state.ts`/`sql.ts` | `session_context_block` persistence (drizzle)                              |
| `invariants.ts`     | The hard rules above                                                       |
| `settings.ts`       | Config resolution and defaults                                             |
| `types.ts`          | Shared shapes                                                              |

## Compression

`compress` is a model-facing tool (`packages/core/src/tool/compress.ts`) and a user command; both
call the same `ContextManager.compress` engine, as does automatic compression.

- Range based: `start_message_id`, `end_message_id`, optional `focus`, optional
  `keep_recent_turns`.
- The summary call is issued with `purpose: "compression"`, which is an **isolated** context: no
  tools, no guidance, no transformation of the session.
- Nested compression composes: an overlapping later range absorbs earlier blocks (they stay stored,
  marked `absorbed_by`) and their summaries are handed to the summarizer as `<prior-summaries>`.
- The result is rendered as a deterministic `<compressed-conversation-section>` placeholder carried
  by a **synthetic** message, lowered to a user-role message. It states that it is historical
  context, not instructions — summaries are untrusted content.
- Protected messages inside an explicitly requested range are **not** summarized: they stay verbatim
  around the placeholder, and the caller is told how many were kept (`excludedMessages` on the
  endpoint, `protected_messages_kept` plus the real `start_message_id`/`end_message_id` on the tool
  output). The block therefore covers the range that was actually compressed, not the one requested.
- Summaries are durable state, so they are capped deterministically at
  `ContextCompressor.MAX_SUMMARY_CHARS` (16 KB) before being stored; a truncated summary ends with a
  marker. `maxTokens` is a request to the provider, not a guarantee, and nested compression reads
  stored summaries back as source material.
- Failures are values, never exceptions: `disabled`, `no-model`, `empty-range`, `invalid-range`,
  `protected-range`, `summary-unavailable`, `timeout`. The turn continues with the canonical context.

### Latency of automatic compression

Automatic compression is deliberately synchronous with the turn that triggered it: `prepare` →
`mandatory` → summarize → persist → `prepare` again → the real request. That costs one extra model
round trip on the turn that crosses the threshold, which is the accepted tradeoff for never sending
an oversized request. It is bounded by `dynamic_compression.timeout_ms` (default 90s); on timeout
the compression is abandoned, `session.next.context.compression.failed` is published, and the turn
proceeds with the reduced-but-uncompressed context. Only the `mandatory` band compresses on its own;
`nudge` and `prefer` merely advise the model and the TUI.

## Protection

Never compressed, deduplicated, or purged:

- The most recent `recent_turns` assistant turns (default 4), plus the newest user and assistant
  message.
- Protected tools: `task`, `skill`, `todowrite`, `todoread`, `compress`, `plan_enter`, `plan_exit`,
  `write`, `edit`, `apply_patch`, `question` — plus anything a tool marks itself with
  `contextPolicy: { protect: true }`. A protected call protects the message that carries it, so it
  survives compression as well as output pruning. Tool-declared policies are remembered per session,
  so `/compress` and the `compress` tool honor them even though they do not materialize tools.
- State-changing tools are never deduplicated (`bash`, `write`, `edit`, `apply_patch`, ...).
- `system`, `compaction`, `agent-switched`, and `model-switched` messages.
- User messages, when `protection.user_messages` is enabled (default off).

### Overlapping ranges

Two compression blocks may not describe overlapping ranges. Compression cannot create that state —
a new range grows over every block it intersects and absorbs them — but a history rewrite or state
written by an older version can. When the compiler meets it, it merges the ranges into one that
describes exactly what it replaces: recomputed boundaries, message count and token count, with both
summaries carried so neither is stranded. The merge is then persisted (the surviving block is
widened, the other is marked absorbed), so the stored state converges on one authoritative range
instead of the projection re-deriving it every turn.

The alternative — emitting both placeholders and clipping the second to whatever is left — was
rejected: the second placeholder would then advertise a range the first had already consumed, and
its stored `sourceMessageCount` would describe messages it did not replace. Metadata that disagrees
with the projection is worse than a merge.

### Escalation latency

Automatic compression happens inside the turn the user is waiting on, so its cost is bounded
explicitly:

- at most **one** summarization request per preparation, and the compaction retry prepares with
  automatic compression disabled, so the worst case a turn can pay is one summarization plus one
  native compaction ahead of the real request — never a ladder;
- the summarization request is bounded by `dynamic_compression.timeout_ms`, after which the turn
  proceeds uncompressed rather than stalling;
- a failure that cost a round trip (timeout, no usable summary, no model) makes the next three
  preparations skip automatic compression, so a summarizer that is down costs its latency once
  rather than on every turn for the rest of the session. A structurally impossible range costs
  nothing and is retried immediately.

## Budget bands

`ContextBudget.recommend(utilization)` maps utilization onto `none | normal | nudge | prefer |
mandatory` using the configured `min_context`/`max_context`. Only `mandatory` triggers autonomous
compression; the other bands are advisory and surface in the TUI. If the prepared payload still
exceeds `context.payload_bytes`, a deterministic ladder runs: dedup → purge errors → collapse
scaffolding → collapse todos → drop oldest.

### The ladder is a pre-pass, the payload check is the enforcement

`ContextBudget.reduce` works on an _estimate_: it sizes messages and the declared envelope without
serializing the provider body, because the body does not exist yet when the reduction is planned.
It is therefore an approximate pre-pass whose job is to make the request plausibly small, not to
prove it fits.

The authoritative measurement is `ContextManager.payload(request)`, which serializes the request the
provider will actually receive and compares it against `context.payload_bytes`. The runner calls it
immediately before `llm.stream` and never sends a request it rejects. When the estimate is
optimistic the cost is one extra escalation step, never an oversized request:

```
prepare (estimate over budget) → automatic compression → prepare again
  → payload(request) still over → native compaction → retry the turn
  → payload(request) still over → the turn fails loudly with a provider error
```

Both directions of estimator error are safe by construction. Pessimistic: the context is reduced
slightly more than it had to be. Optimistic: `payload` catches it and the escalation above runs.

An unmeasurable request is not a fitting request. If the provider body cannot be built at all,
`payload` reports `measured: false` and `within: false` rather than falling back to an estimate: the
ceiling is a hard rule, and "the size could not be checked" is not permission to send. Such a
request takes the same path as an oversized one — one recovery attempt, then an explicit provider
error naming the encoding failure.

## Configuration

```jsonc
{
  "context": {
    "dynamic_compression": {
      "enabled": true,
      "mode": "range",
      "automatic": true,
      "min_context": 0.6,
      "max_context": 0.85,
      "timeout_ms": 90000,
    },
    "deduplication": { "enabled": true },
    "purge_errors": { "enabled": true, "turns": 4 },
    "protection": {
      "recent_turns": 4,
      "user_messages": false,
      "tools": ["my_tool"],
      "files": ["docs/**"],
    },
    "payload_bytes": 4000000,
  },
}
```

### Merge semantics

Configuration documents are folded in order, from the broadest to the most specific. Scalars
(`enabled`, `automatic`, `recent_turns`, `payload_bytes`, ...) are last-wins, so the workspace file
decides. The protection arrays (`tools`, `files`) accumulate instead, deduplicated: `protection.tools`
extends the built-in list rather than replacing it, and a project file that protects one more tool
does not silently discard what a broader file protected.

This is intentional and it has a deliberate consequence: a narrower document can only _add_
protection, never remove an inherited entry. Reducing protection is still possible, but only through
choices that read as choices — lowering `recent_turns`, leaving `user_messages` off, or disabling a
stage outright — rather than through the accident of one file shadowing another's safety rule.

### Feature gates

Every stage is individually switchable, and the switches are the rollout mechanism:
`dynamic_compression.enabled` turns the whole compression engine off (`/compress` and the `compress`
tool then report `disabled`), `dynamic_compression.automatic` keeps the engine available for
explicit use but never triggers it on its own, and `deduplication.enabled` / `purge_errors.enabled`
gate the two automatic pruning stages. With all of them off the compiler is a passthrough, and
internal requests (`ContextTypes.isolated` purposes) are a passthrough regardless.

## API

| Endpoint                             | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `POST /api/session/:id/compress`     | Compress a range; returns `compressed` or `skipped` |
| `GET /api/session/:id/context/stats` | Utilization, tokens saved, compression count, band  |

Exposed on the SDK as `session.compress(...)` and `session.contextStats(...)`.

## Events (plugin lifecycle)

Published on the event bus and forwarded to clients and plugins. All are advisory and non-durable:
persistence lives in the session history and the `session_context_block` table.

| Event                                     | Hook               |
| ----------------------------------------- | ------------------ |
| `session.next.context.preparing`          | before prepare     |
| `session.next.context.prepared`           | after prepare      |
| `session.next.context.compressing`        | before compress    |
| `session.next.context.compressed`         | after compress     |
| `session.next.context.compression.failed` | compression failed |

## TUI

- The prompt indicator reports the prepared token count, utilization, and reclaimed tokens, and
  turns amber once the band reaches `prefer`.
- The sidebar context panel adds reclaimed tokens and the number of compressed sections.
- `/compress` (command palette: "Compress context") compresses everything outside the protected
  recent window.

## Tests

- `packages/core/test/context-compiler.test.ts` — unit coverage of every stage plus the invariants.
- `packages/core/test/context-manager.test.ts` — runner integration against a fake LLM: one system
  prompt, dedup/purge visible only in the provider request, compression round-trip, nested
  compression, graceful failure, protected ranges, statistics events.
- `packages/core/test/context-manager.test.ts` also covers the escalation chain end to end —
  automatic compression, a payload still over the ceiling, native compaction, and a coherent next
  turn — and pins `stats()` as observational: it never publishes events, deletes stale boundaries,
  or changes what the next turn prepares.
- `packages/core/test/context-provider-property.test.ts` — 200 generated conversations (seeded, so
  failures are reproducible) with random compression boundaries and protection policies lowered
  through all three providers, asserting tool call/result adjacency survives arbitrary boundaries.
- `packages/core/test/context-provider-shape.test.ts` — OpenAI Chat, Anthropic Messages, and Gemini
  request bodies keep one system prompt, paired tool calls, and user-side placeholders, including
  the awkward case: a compressed range that contains a protected tool interaction followed by a
  further user turn. Each provider is checked for strict call/result adjacency, not just matching
  id sets.

## Non-goals

DCP plugin installation or auto-update, a standalone DCP config file, a dedicated TUI panel,
experimental per-message compression, provider-specific hacks, and independent subagent compression.
