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
against the real request rather than the history alone. And before any turn exists, `stats` rebuilds
that envelope read-only from the session's agent — its system prompt, the context guidance and the
materialized tool definitions — so the very first `GET /context/stats` reports utilization against
the real prompt too. Two request parts remain uncountable until they exist: the epoch context-file
baseline (it joins on the first prepared turn) and the max-steps trailing message (it depends on
the step counter).

Every stage is pure and monotonic: once a call is superseded or an error input is stale, it stays
that way. The request prefix therefore only changes when something genuinely new happens, which
keeps provider prompt caching useful.

### Runtime cost

`prepare` runs before every provider request, so the first case that matters is the one where nothing
needs reducing. The second is the worst one: a history far over the byte ceiling, constructed so the
deterministic ladder cannot stop early (every tool call takes distinct arguments, no failed calls,
nothing collapsible) and the drop loop walks the whole eligible prefix. The script asserts that the
ladder ends in the drop rung, times `ContextBudget.reduce` directly, and prints the executed steps.
`packages/core/script/context-benchmark.ts` measures both and reports, on a development machine:

| History        | Serialized | Preparation | Full ladder (`ContextBudget.reduce`) |
| -------------- | ---------- | ----------- | ------------------------------------ |
| 100 messages   | 62 KiB     | ~1.1 ms     | ~0.8 ms                              |
| 500 messages   | 313 KiB    | ~3.9 ms     | ~3.3 ms                              |
| 2,000 messages | 1.2 MiB    | ~14.8 ms    | ~13.8 ms                             |
| 8,000 messages | 4.9 MiB    | ~63.7 ms    | ~61.1 ms                             |

The cost per KiB of serialized history stays flat across the measured range (roughly 0.01 ms/KiB at
every size), so both curves scale approximately linearly with payload, and serialization dominates
them: `ContextBudget.measure` returns tokens and bytes from a single `JSON.stringify` so the
pipeline serializes each list once, and the drop loop derives each candidate size arithmetically
from per-message sizes measured once — `JSON.stringify` of an array is its elements joined by
commas inside brackets, so a removal is a subtraction. The alternative — re-serializing the whole
history per drop candidate — is quadratic on precisely the inputs the ladder exists for, and the
script measures that comparison too: at 2,000 messages the arithmetic sizing costs ~14 ms where the
naive loop costs ~7,700 ms (~550x), growing to ~140,000 ms at 8,000 messages.
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
- A block is defined as the exact set of messages its summary represents. Its boundaries are the
  first and last **summarized** message, and `sourceMessageCount`/`sourceTokenCount` measure that
  subset only, never the wider requested range or a merged union. The first placeholder segment
  declares the same accounting — `summarized: N messages (~T tokens) spanning <start>-<end>`, plus
  how many messages were kept verbatim between the sections — so the metadata can never read as if
  a retained message were part of the summary.
- Summaries are durable state, so they are capped deterministically at
  `ContextCompressor.MAX_SUMMARY_CHARS` (16 KB) before being stored; a truncated summary ends with a
  marker. `maxTokens` is a request to the provider, not a guarantee, and nested compression reads
  stored summaries back as source material. The cap applies to merged summaries too: concatenating
  two 16 KB summaries and merging again later would make durable state grow without bound, so the
  merge keeps the newest half in full and gives the older half whatever room remains, marked with
  `[earlier summary trimmed to fit the summary budget]`.
- Failures are values, never exceptions: `disabled`, `no-model`, `empty-range`, `invalid-range`,
  `protected-range`, `summary-unavailable`, `timeout`. The turn continues with the canonical context.

### Latency of automatic compression

Automatic compression is deliberately synchronous with the turn that triggered it: `prepare` →
`mandatory` → summarize → persist → `prepare` again → the real request. That costs one extra model
round trip on the turn that crosses the threshold, which is the accepted tradeoff for never sending
an oversized request. It is bounded by `dynamic_compression.timeout_ms` (default **30s**), which
caps the interactive latency a turn can pay for summarizing — a slow summarizer degrades to an
uncompressed turn, and the failure backoff below keeps it from being paid twice. On timeout the
compression is abandoned, `session.next.context.compression.failed` is published, and the turn
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

This list has no override, including on the byte-budget fallback: `ContextBudget.reduce` runs the
same planners with a wider mandate, but every rung still yields to protection. Earlier drafts had a
`force` flag that suspended recent-turn protection in exactly that path, which meant a conversation
could lose a recent, protected result precisely when the payload was under the most pressure. It was
removed; a fallback that cannot shed anything unprotected reports `needsCompression` and the
pipeline escalates (automatic compression, then native compaction) instead of pruning anyway.

### Overlapping ranges

Two compression blocks may not describe overlapping ranges. Compression cannot create that state —
a new range grows over every block it intersects and absorbs them — but a history rewrite or state
written by an older version can. When the compiler meets it, it merges the ranges into one that
describes exactly what it replaces: recomputed boundaries, message count and token count — all
measured over the summarized subset of the union, since the protected messages kept verbatim were
in neither summary — with both summaries carried so neither is stranded. The merge is then
persisted (the surviving block is widened, the other is marked absorbed), so the stored state
converges on one authoritative range instead of the projection re-deriving it every turn.

The alternative — emitting both placeholders and clipping the second to whatever is left — was
rejected: the second placeholder would then advertise a range the first had already consumed, and
its stored `sourceMessageCount` would describe messages it did not replace. Metadata that disagrees
with the projection is worse than a merge.

A block contained _entirely_ inside a wider one is the quieter version of the same state: it still
resolves, so it is not stale, and there is no union to widen into, so it is not merged either — the
projection simply skips it in favour of the cover. Such a block can never re-enter the projection,
so preparing reports it and the next real turn absorbs it into the cover (`absorbed_by`), the same
convergence the merge path gets. Like every other cleanup, observation (`stats`) reports but does
not persist: only turns mutate storage.

### Escalation latency

Automatic compression happens inside the turn the user is waiting on, so its cost is bounded
explicitly:

- at most **one** summarization request per turn: whichever runs first — preparation's automatic
  compression or the payload gate's recovery attempt — marks the turn as spent, so the worst case
  a turn can pay is one summarization plus one native compaction ahead of the real request — never
  a ladder and never two summarizations;
- the summarization request is bounded by `dynamic_compression.timeout_ms`, after which the turn
  proceeds uncompressed rather than stalling;
- a failure that cost a round trip (timeout, no usable summary, no model) makes the next three
  preparations skip automatic compression, so a summarizer that is down costs its latency once
  rather than on every turn for the rest of the session. A structurally impossible range costs
  nothing and is retried immediately. Suppressed does not mean unguarded: during those three
  preparations turns can still be over the byte ceiling, and the hard `payload` gate still applies,
  so an oversized turn takes the native-compaction recovery path on each of them — three
  compaction-recovered turns at worst, then compression is tried again.

## Budget bands

`ContextBudget.recommend(utilization)` maps utilization onto `none | normal | nudge | prefer |
mandatory` using the configured `min_context`/`max_context`. Only `mandatory` triggers autonomous
compression; the other bands are advisory and surface in the TUI. If the prepared payload still
exceeds `context.payload_bytes`, a deterministic ladder runs: dedup → purge errors → collapse
scaffolding → collapse todos → drop oldest.

### Byte pressure is reported separately from window pressure

`recommendation` describes context-window utilization and nothing else. Byte pressure is a distinct
condition — a session at 12% of a 200k-token window can still produce a request over the byte
ceiling — so it is reported on its own boolean, `payloadOverBudget`, on
`session.next.context.prepared` and on the context stats endpoint. Both conditions trigger
autonomous compression; neither is described in the other's vocabulary. Reporting bytes as
`mandatory` would tell every client the context window was critical while it was nearly empty.

A payload the ladder still cannot fit is logged as `context.prepare.over-budget` and carried on that
flag. It is deliberately _not_ a `session.next.context.compression.failed` event: nothing failed to
summarize, and plugins that react to compression failures must not be woken by ordinary byte
pressure.

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
  → payload(request) still over → one dynamic-compression attempt, when the turn has not
    spent one yet → retry the turn
  → payload(request) still over → native compaction → retry the turn
  → payload(request) still over → the turn fails loudly with a provider error
```

Both directions of estimator error are safe by construction, and both directions exist: the
estimate sums canonical-history JSON bytes with a `JSON.stringify` of `[system, tools, extra]`,
neither of which is the provider-native body the wire actually carries. Pessimistic: the context is
reduced slightly more than it had to be. Optimistic: the ladder and automatic compression stand
down when they should have run, `payload` catches the oversized request instead, and the gate
decides explicitly, in cost order: dynamic compression is the cheaper lever so it gets exactly one
attempt before native compaction is even considered — skipped only when the preparation already
compressed this turn, when this attempt is itself the post-compression retry, or when the body
could not be measured at all, which is a structural failure a smaller context does not repair. If
the compressed retry still overflows, native compaction follows — the path the optimistic-estimate
tests in `context-manager.test.ts` pin end to end, both where the compression attempt suffices and
where it does not.

The estimate also corrects itself: every measured wire request reports back how many bytes it cost
beyond the prepared canonical list, and planning budgets against the larger of the estimate and
that observed overhead. An optimistic gap therefore survives at most until the session's first
measured request, after which decisions track the wire. Only divergence that makes planning more
conservative is kept; the hard gate above remains the final arbiter either way.

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
      "timeout_ms": 30000,
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
