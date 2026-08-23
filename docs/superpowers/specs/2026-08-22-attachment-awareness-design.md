# Attachment Awareness & Materialization — Design

> Status: draft for review (brainstorming architectural path). Not yet implemented.
> Tracking issue: closes the gap documented in `specs/v2/session.md:148` ("Materialize and normalize sources instead of lowering unresolved attachment metadata") and `specs/v2/todo.md:136` ("materialize or consistently reject unresolved URL and file attachment sources").

## Problem

Today an attachment in AlphaCode's V2 session is only a `{ uri, mime, name? }` record:

1. The app builds `FilePartInput` with `url` = `data:…;base64,…` (pasted images) or `file:///abs/path` (mentions). (`packages/app/src/components/prompt-input/build-request-parts.ts`)
2. `V2Session.resolvePrompt` (`packages/core/src/session.ts:460`) only guesses the `mime` from the URI. **Nothing is materialized.**
3. `Prompt.FileAttachment` (`packages/schema/src/prompt.ts`) persists only the URI.
4. `to-llm-message.ts:13` lowers **every** attachment to `{ type: "media", data: file.uri }`. `ProviderShared.validateMedia` then requires base64/data-URL and a media MIME — so `file://` mentions and `text/plain` attachments are rejected or silently dropped.
5. There is **no tool and no context entry** describing attachments, so the agent has no awareness of what was attached and cannot persist it as a project file.

Consequence: a user who pastes a screenshot or attaches a CSV/log cannot have the agent reason about the bytes or save them into the repo. The agent treats attachments as opaque "untouchable" media sent to the provider.

## Decisions (from user)

- **Form:** Hybrid — automatic managed materialization **plus** an `attachment` tool with `list`/`save`. (Approach C)
- **Save destination:** agent-chosen workspace path, gated through `edit` permission via `LocationMutation` (same UX as the `write` tool). Managed store is only a cache, not the save target.
- **Awareness:** a System Context Source (`core/attachments`) that inventories the session's materialized attachments. (No per-message inline rewrite; the required path lives on the durable `FileAttachment`.)
- **Coverage:** close the gap — resolve `data:` (pasted media), `file://` (mentioned files), and remote `http(s)://` URLs. MCP-resource materialization is explicitly deferred.

## Design

### 1. Schema (`packages/schema/src/prompt.ts`)

Add two optional durable fields to `Prompt.FileAttachment`:

- `path?: Schema.String` — absolute path of the materialized local copy in the managed attachment store (populated at admission; absent for not-yet-materialized / remote-failed).
- `size?: Schema.Number` — byte length of the materialized copy (for the inventory and previews).

`PromptInput.FileAttachment` is left unchanged (the client still sends only `uri`/`name`/`description`/`source`). `Prompt.FileAttachment.create` is extended to forward the new fields.

`FilePart` (V1 `packages/schema/src/v1/session.ts`) is out of scope and untouched.

### 2. `AttachmentStore` (`packages/core/src/attachment-store.ts`)

Mirrors the `ToolOutputStore` pattern (managed directory under `Global.data/attachments`, retention, location-scoped node). Responsibility: turn a `Prompt.FileAttachment` (raw URI) into a materialized local copy and return the enriched `Prompt.FileAttachment`.

Interface:
- `materialize(attachment: Prompt.FileAttachment): Effect<Prompt.FileAttachment>` — classify by final MIME (data: media type, or `FSUtil.mimeType(target)`):
  - `data:`: decode base64 → bytes.
  - `file://`: read from disk (subject to `LocationMutation`/read permission at admission time).
  - `http(s)://`: fetch via the core HTTP client; requires the `web` capability.
  - Write bytes to `attachments/<sessionID>/<id>.<ext>` (extension derived from MIME).
  - Return `{ ...attachment, path, size }`. On unreachable remote / unreadable file, return the original attachment unchanged (so durable history is never lost; the Context Source will flag `unavailable`).
- `cleanup(): Effect<void>` — drop materialized files older than retention (spaced schedule, like `ToolOutputStore`).

No `data:` URL is ever sent to the provider for a managed attachment: the media part uses the local `path` bytes.

### 3. Admission materialization (`packages/core/src/session.ts` → `resolvePrompt`)

`resolvePrompt` (currently pure) becomes an `Effect` that, for each input file, calls `AttachmentStore.materialize` before building the durable `Prompt`. The enriched `path`/`size` are persisted on the user message, so history replay and the Context Source see consistent data. Remote fetches that fail degrade gracefully (attachment kept without `path`).

### 4. Lowering (`packages/core/src/session/runner/to-llm-message.ts`)

Rewrite the `media()` helper into `contentFor(attachment)`:
- **Media MIME** (`image/*`, `video/*`, `audio/*`): emit `{ type: "media", mediaType, data: <base64 from managed path>, filename, metadata: description }`. Always backed by the materialized managed copy → passes `validateMedia`.
- **Text-like MIME** (`text/*`, `application/json`, `application/xml`, `application/csv`, …) **and** an available `path`: inline the file's text as a `text` part (bounded by the store's text limits), wrapped with a header naming the attachment (`filename`, `mime`, `source.path` if present). This replaces the invalid `{ type: "media", data: "file://…" }` lowering that breaks today.
- **Unavailable** (`file://` unreadable, remote failed, no `path`): emit a `text` note like `[attachment <name>: source unavailable]` so the model is told rather than receiving a rejected request.

This is the core fix for the documented gap: sources are materialized and normalized instead of lowered as unresolved metadata.

### 5. Awareness — Context Source (`core/attachments`)

New location node `packages/core/src/attachment-awareness.ts` (deps: `SessionProjector`, `SystemContextRegistry`, `FSUtil`, `Global`). On `register` it adds a `SystemContext.make` source keyed `core/attachments`:

- `codec`: array of `{ id, name?, mime, source?: ("paste"|"file"|"url"), path?, size?, unavailable? }`.
- `load`: read projected `user` messages for the session, flatten `files`, map each to the inventory row (`source` derived from URI scheme / `source.type`).
- `baseline`/`update`: render a compact inventory, e.g.:

  ```
  Attachments in this session (materialized locally; use the `attachment` tool to inspect or save):
  - id=att_01 name="screenshot.png" mime=image/png source=paste path=/…/attachments/<sess>/att_01.png size=12345
  - id=att_02 name="data.csv" mime=text/csv source=file path=/…/data.csv size=2048
  ```

Registered as a `core/*` source alongside `system-context/builtins.ts`; folded into the existing System Context composition.

### 6. `attachment` tool (`packages/core/src/tool/attachment.ts`)

Registered in `packages/core/src/tool/builtins.ts` (after `write`). Two modes via a discriminated `action` input:

- `list`: returns the same inventory as the Context Source (per-session, from `SessionProjector`), but the agent can call it on demand. `toModelOutput` shows a short table.
- `save`: `{ id, path }` — copies the materialized attachment bytes (resolved from the inventory `path`) to the agent-chosen workspace `path`, using `LocationMutation.resolve({ path, kind: "file" })` and asserting the `edit` permission (external paths require `external_directory` approval first, exactly like `write`). Returns the written `resource`. Missing/unavailable source → `ToolFailure`.

Out of scope for this slice (noted in the plan, follow-ups only): `save-all`, `delete`, MCP-resource materialization.

## Interfaces (signatures the plan will implement)

```ts
// schema/prompt.ts
Prompt.FileAttachment += { path?: string; size?: number }

// core/attachment-store.ts
export interface AttachmentStore {
  materialize(a: Prompt.FileAttachment): Effect.Effect<Prompt.FileAttachment>
  cleanup(): Effect.Effect<void>
}

// core/attachment-awareness.ts
// registers SystemContext source key "core/attachments"

// core/tool/attachment.ts
// tool "attachment": action "list" | ("save" & { id, path })
```

## Risks / trade-offs

- **Disk growth:** managed store + retention + cleanup mirrors `ToolOutputStore`; media attachments are bounded by `MAX_MEDIA_*` limits at provider time.
- **Remote fetch:** gated by `web` capability; failures degrade to "unavailable" rather than erroring the whole prompt.
- **Text inlining size:** reuse a bounded preview (head/tail) so large text attachments do not blow the provider context; full bytes remain on disk and reachable via `read`/`bash`.

## Out of scope (deferred)

- MCP-resource attachments (`ResourceSource`) materialization.
- `ToolStateCompleted.attachments` (webfetch/read output) added to the inventory — tracked separately.
- Per-message inline attachment references (the Context Source + durable `path` already give the agent what it needs).
