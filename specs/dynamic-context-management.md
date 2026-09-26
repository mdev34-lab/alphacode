# Dynamic Context Management

Native context engineering for AlphaCode sessions: the context one provider request carries is
**derived** from canonical history on every turn, never mutated in place. Inspired by the Dynamic
Context Plugin (DCP), re-implemented against the Effect-based V2 session runtime.

## Problem

A long session sends the same bytes to the provider again and again: repeated `read` of the same
file, the full input of a command that failed twenty turns ago, exploration that is finished and no
longer load-bearing. Native compaction only helps at the very end, by discarding everything at once.

The question DCP has to answer is narrow: **given the authoritative session history and the request
the runtime is about to send, what is the minimal deterministic operation that derives the context
the model should receive when that request comes under pressure?** Everything else — persistence,
lifecycle, ownership, client state — is a consequence of that one question, and the previous
implementation accumulated a second architecture to answer it.

## Design

One owner, one derivation, one report.

- **Owner.** `SessionRunnerLLM` (`packages/core/src/session/runner/llm.ts`) is the only place that
  knows what a request carries. It loads history, builds the envelope, calls the reduction, lowers
  the result, gates it, builds the request, publishes the report and streams.
- **Derivation.** `SessionContextReduction.reduce` (`packages/core/src/session/context-reduction.ts`)
  is a pure function of the canonical history, the envelope, the model and the resolved policy. It
  has no state, no service, no cache, no table and no API.
- **Report.** The reduction returns the measurement of what it produced. The runner publishes it once
  per provider request, and every consumer renders that report instead of deriving its own.

There is no DCP state to persist, so there is none: a turn cannot inherit a stale projection, a
restart cannot lose one, and no consumer can disagree with the runtime about what was sent.

```
canonical history + request envelope + policy
  → SessionContextReduction.reduce      (projection + report)
  → toLLMMessages                       (lowering)
  → transmittable                       (pairing gate: reduced, else canonical)
  → LLM.request                         (the request that is sent)
  → SessionEvent.Context.Prepared       (the report for exactly that request)
```

## Hard rules

1. **Canonical history is authoritative and immutable.** Reduction returns a _projection_: some of
   the same messages, in the same order, where a few recorded tool payloads have been replaced by
   smaller equivalents. Nothing is written back to the session.
2. **No fabrication, no reordering, no rewriting of model text.** Rungs only replace recorded tool
   payloads and drop whole messages. Assistant prose and user prompts are never edited.
3. **The reduction affects the real request path.** It runs on the messages the runner is about to
   lower and send — not on a prompt-level approximation, and not on a parallel representation.
4. **The whole request is budgeted.** The system prompt, the tool definitions and request-level
   extras are measured with the history, because they are what the provider actually receives.
5. **Deterministic and monotonic.** Every rung is a function of the messages alone, and once a call
   is superseded, an input is stale, or a message is dropped, it stays that way as the session grows.
   The request prefix therefore only changes where something genuinely new happened, which keeps
   provider prompt caching useful.
6. **Below the threshold nothing happens.** The canonical history is sent untouched, byte for byte.

## The contract

```ts
SessionContextReduction.reduce({
  messages,     // canonical history, exactly as the runner loaded it
  envelope,     // { system, tools, extra } — what the request carries besides history
  model,        // its declared context and output limits give the usable window
  policy,       // folded from config (see Configuration)
  toolPolicies, // what the materialized tools declared for themselves
}): {
  messages,       // the projection to lower and send
  report,         // the authoritative measurement of that projection
  fallbackReport, // the measurement of canonical history, for the gate below
}
```

The usable window is `model.context - max(model.output)`, and the reduction target is
`threshold × window`: reduction aims at the threshold rather than at the window itself so the
response keeps its headroom. A model that declares no context limit has nothing to be under pressure
against, and reduction stays out of the way.

### Measuring the request

`size(value)` is the serialized length of the value as the request carries it, and
`Token.fromLength` converts characters to tokens. Two details matter:

- **The envelope is priced the same way as history.** The runner builds `system`, `tools` and
  `extra` once and hands the same values to both the reduction and the request, so budgeting cannot
  drift from transmission. Without this a session with a large toolset believes it is at 70% while
  the provider sees 95%.
- **Measurement prices the transmission, not the storage.** A locally executed tool call stores its
  result beside `content` and `structured`; the lowering re-derives the provider value from those
  and `state.result` never reaches a provider. Counting it would roughly double every tool output
  and start reduction at half the real utilization.

Accounting is compositional: JSON is a tree, so a subtree appears verbatim inside its parent's
serialization, and a rung reports what it removed by differencing two subtree lengths. The history is
serialized once per reduction instead of once per candidate — reduction runs precisely on the
histories that are too large to serialize repeatedly.

## The rungs

Over the target, the rungs run in a fixed order — cheapest and least destructive first — and the
ladder stops as soon as the request fits. The first three run to completion; the fourth stops the
moment it can.

| #   | Rung               | Takes                                                          | Leaves                                                       |
| --- | ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `duplicateOutputs` | the output of a superseded identical `name(arguments)` call    | the call record and a marker; the newest copy stays verbatim |
| 2   | `staleErrorInputs` | the input of a failed call older than `error_turns`            | the tool name, the error and the diagnostic                  |
| 3   | `staleOutputs`     | the middle of an oversized completed output outside the window | the call, the head and the tail of its output                |
| 4   | `dropOldest`       | whole unprotected messages before the protected recent window  | everything from the window onwards                           |

Reading the same file five times is one fact, not five; a failure stays useful long after the 500 KB
script that produced it does not; and dropping whole messages is genuinely last, because a model
that cannot see the exploration it just did re-does it.

Rungs 1–3 replace payload with an explicit marker rather than with silence, so the model can tell
that something was there and can re-read the source when it needs the middle:

- `[duplicate tool output pruned: an identical call is repeated later in this conversation]`
- `[input purged: this call failed and its input is no longer part of the request]`
- `[stale tool output truncated]`

A recorded payload smaller than `MINIMUM_SAVING` (256 characters) is left alone: pruning it saves
less than it churns, and churn is what costs the prompt cache.

If every rung has run and the request is still over the target, the outcome is `exhausted` and the
runtime escalates to compaction — it never reduces further by taking protected content.

## Protection

Protection is resolved once per reduction (`protect`) and every rung consults the same result, so
the rungs cannot disagree about what is untouchable.

- **The recent window.** The last `recent_turns` assistant turns, starting at the user message that
  provoked the first of them: a turn's question is protected with its answer.
- **The newest user input and the newest assistant turn**, whatever the window says. A request that
  cannot see the question it is answering is worse than an oversized one.
- **Protected tools** — `apply_patch`, `edit`, `question`, `skill`, `todowrite`, `write`, plus
  anything a tool declares with `contextPolicy.protect` or config adds with `protection.tools`.
  Losing these changes how the agent reasons about the current task rather than merely making it
  re-read stale information. A protected call also protects the message carrying it, because
  dropping that message would drop the call.
- **Protected files.** `protection.files` globs are matched against the path-like keys of a call's
  input (`file`, `filePath`, `filename`, `path`, `source`, `target`).
- **Provider-executed calls.** AlphaCode did not record their result and cannot reconstruct it, so
  no rung may touch them.
- **State-changing tools** — `apply_patch`, `attachment`, `bash`, `edit`, `question`, `todowrite`,
  `webfetch`, `websearch`, `write` — are never deduplicated even when their arguments match: two
  identical calls are two different observations. A tool can opt out of deduplication explicitly
  with `contextPolicy.deduplicate: false`.
- **Runtime state messages** — `compaction`, `system`, `agent-switched`, `model-switched` — are
  never dropped.
- **User messages**, when `protection.user_messages` is set.

## The transmission gate

Every provider rejects a tool call that is not answered next, and only the lowered messages show
where calls and results actually land. So the last check before transmission runs on them, not on
the canonical projection (`pairing` / `transmittable` in `session/runner/to-llm-message.ts`):

1. the reduced messages pair → send them;
2. they do not, and canonical history pairs → send canonical history and publish `fallbackReport`,
   because the request that is sent must be described by its own numbers rather than by the
   reduction that was thrown away;
3. neither pairs → nothing here can repair it, and the turn fails with the reason instead of sending
   a conversation known to be malformed.

Canonical history is only lowered in case 2, so the common path lowers once.

## Escalation: compaction

Native compaction (`session/compaction.ts`) is unchanged and remains the durable mechanism: it
summarizes history into a `compaction` message and later turns load from that boundary. Reduction is
the cheap, per-request mechanism in front of it, and compaction is what runs when reduction reports
`exhausted` or when the lowered request is over the model's compaction trigger. Reduction never
writes to the session, so the two cannot corrupt each other's state.

## The report

`SessionContext.Report` (`packages/schema/src/session-context.ts`) is the single authoritative
context measurement:

| field             | meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `tokens`          | tokens the request carries: the sent history plus the prompt envelope |
| `overheadTokens`  | the envelope share of `tokens`                                        |
| `reclaimedTokens` | tokens reduction removed from canonical history                       |
| `limit`           | usable window `utilization` is measured against, when one is declared |
| `utilization`     | fraction of the usable window the request occupies                    |
| `outcome`         | `untouched` \| `reduced` \| `exhausted`                               |

It is published as `session.next.context.prepared` (`SessionEvent.Context.Prepared`), once per
provider request, immediately before the request is streamed — so the report arrives with the
request it describes and can never be about a different one. The event is advisory and not durable,
because there is no durable reduction state to recover: the next request re-derives its context from
canonical history.

This replaces the previous twelve-field stats struct, its five lifecycle events, the persisted
`session_context_block` table, `GET /session/:id/context/stats` and `POST /session/:id/compress`.
There is no compatibility layer: a client that wants context figures subscribes to the report.

## Configuration

```jsonc
{
  "context": {
    "reduction": {
      "enabled": true, // reduce when a request comes under context pressure
      "threshold": 0.8, // fraction of the usable window reduction starts at, and targets
      "error_turns": 4, // assistant turns a failed call keeps its original input for
    },
    "protection": {
      "recent_turns": 4, // recent assistant turns that are never reduced
      "user_messages": false, // keep every user message verbatim
      "tools": [], // additional tool names whose recorded calls are never reduced
      "files": [], // glob patterns whose file operations are never reduced
    },
  },
}
```

**Merge semantics.** Documents are folded in order (`SessionContextReduction.policy`). Scalars are
last-wins, so the most specific document decides. The protection arrays accumulate instead:
protection is a safety rule, and a project file that protects one more tool must not silently
discard what a broader file protected. A narrower document can therefore only _add_ protection;
widening reduction stays an explicit choice (`enabled`, `threshold`, `recent_turns`).

## Consumers

The TUI has one derivation, `contextUsage` (`packages/tui/src/util/context-usage.ts`), used by the
prompt indicator, the sidebar and the subagent footer. It renders the report; before a session's
first request exists there is no report, and the fallback is the provider's own token accounting for
the last assistant turn — a different quantity, used only so the indicator is not empty, never mixed
into the report's numbers. No client recomputes utilization, budget bands or reclamation, and there
is no client-side refresh of context state to fall out of sync.

Plugins receive the same report through the event stream.

## Tests

`packages/core/test/session-context-reduction.test.ts` drives the real runner and session path —
prompt in, provider request out — against a fake LLM client, and asserts on what the model received,
what the session still records, and what the runtime published:

- a request that fits sends canonical history untouched, with one report per provider request;
- under pressure the request is reduced — superseded duplicate outputs pruned, a stale failed input
  purged while its diagnostic survives, an oversized stale output truncated to its two ends, the
  oldest turns dropped last — while canonical history keeps every byte;
- a tool-declared protected call stays verbatim while its neighbours are reduced;
- the envelope is budgeted: a history far below the target still reduces when the system prompt puts
  the request over it, and reports `exhausted` when the envelope itself is not reducible;
- reduction persists across turns instead of resetting: the whole previous request is still the
  byte-identical prefix of the next one;
- disabling reduction is a passthrough even under real pressure;
- when everything is protected the report says `exhausted` and the runtime escalates to compaction,
  after which the next request carries the checkpoint.

Fixtures are sized against measured request weights, and each test states the arithmetic next to the
model window it selects.

## Non-goals

- **No durable reduction state.** Nothing about a reduction outlives the request it produced.
- **No prompt-level approximation.** Reduction is not a system-prompt instruction asking the model to
  ignore earlier content; it changes the bytes that are sent.
- **No summarization inside reduction.** Summarizing is compaction's job, and it is durable.
- **No separate context API.** The report rides the event stream with the request it describes.
- **No duplicated derivation.** Backend and clients share one report; there is no second
  implementation of utilization to diverge.
