# Attachment Awareness & Materialization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AlphaCode's V2 agent aware of conversation attachments and able to persist them as project files, instead of only shipping opaque media to providers.

**Architecture:** A location-scoped `AttachmentStore` materializes each prompt attachment (`data:`, `file://`, `http(s)://`) into a managed directory and records a durable local `path`/`size` on `Prompt.FileAttachment`. `to-llm-message` lowers sources correctly (media bytes from the managed copy; text inlined). A `core/attachments` System Context Source inventories the session. A new `attachment` tool exposes `list` and `save` (agent-chosen workspace path, gated by `edit`).

**Tech Stack:** TypeScript, Effect, Bun, Drizzle (SQLite). Schema in `@opencode-ai/schema`, runtime in `@opencode-ai/core`.

**Spec:** `docs/superpowers/specs/2026-08-22-attachment-awareness-design.md`

## Global Constraints

- Never edit `src/generated` or `src/generated-effect` directly; run `bun run generate` from `packages/client` after Protocol/Schema changes.
- Run `bun typecheck` from `packages/core` (never `tsc` directly).
- Tests run from the package dir (`packages/core`), never repo root.
- Follow AGENTS.md style: `const` over `let`, early returns over `else`, no `any`, Bun APIs (`Bun.file`) preferred, no unnecessary destructuring.
- Keep `AttachmentStore` Location-scoped; reuse the `ToolOutputStore` managed-directory + retention pattern.
- `PromptInput.FileAttachment` (client contract) stays unchanged; only `Prompt.FileAttachment` gains `path`/`size`.

---

### Task 1: Extend `Prompt.FileAttachment` schema

**Files:**
- Modify: `packages/schema/src/prompt.ts`

**Interfaces:**
- `Prompt.FileAttachment` gains optional `path: Schema.String` and `size: Schema.Number`.
- `Prompt.FileAttachment.create` forwards `path`/`size`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/schema/test/prompt.test.ts (create if absent)
import { Prompt } from "@opencode-ai/schema/prompt"
import { describe, it, expect } from "bun:test"

describe("Prompt.FileAttachment", () => {
  it("accepts optional path and size", () => {
    const attachment = Prompt.FileAttachment.create({
      uri: "file:///x/y.png",
      mime: "image/png",
      path: "/managed/attachments/sess/att_1.png",
      size: 1234,
    })
    expect(attachment.path).toBe("/managed/attachments/sess/att_1.png")
    expect(attachment.size).toBe(1234)
  })
  it("round-trips without path/size", () => {
    const a = Prompt.FileAttachment.create({ uri: "data:image/png;base64,AAA", mime: "image/png" })
    expect(a.path).toBeUndefined()
    expect(a.size).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `cd packages/schema && bun test prompt` (fails: unknown field).
- [ ] **Step 3: Implement**

```ts
export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
  path: Schema.String.pipe(optional),
  size: Schema.Number.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
          path: input.path,
          size: input.size,
        }),
    })),
  )
```

- [ ] **Step 4: Run test to verify it passes** — `cd packages/schema && bun test prompt`
- [ ] **Step 5: Commit** — `git commit -m "feat(schema): add path/size to Prompt.FileAttachment"`

---

### Task 2: `AttachmentStore` materialization service

**Files:**
- Create: `packages/core/src/attachment-store.ts`
- Create: `packages/core/src/attachment-store.test.ts`

**Interfaces:**
- `AttachmentStore.materialize(attachment: Prompt.FileAttachment): Effect<Prompt.FileAttachment>`
- `AttachmentStore.cleanup(): Effect<void>`

- [ ] **Step 1: Write the failing test** (covers: data: decode → file written with path/size; file:// read; http(s) failure → unchanged; text/plain still materialized)

```ts
import { AttachmentStore } from "./attachment-store"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Effect } from "effect"
import { describe, it, expect } from "bun:test"

const run = (layer: Layer.Layer<AttachmentStore.Service>) => (effect: Effect.Effect<unknown, unknown, AttachmentStore.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe("AttachmentStore", () => {
  it("materializes a data: attachment to a managed file", async () => {
    const store = AttachmentStore.test({
      global: { data: "/tmp/att-test" },
      sessionID: "sess_1" as any,
    })
    const input = Prompt.FileAttachment.create({ uri: "data:text/plain;base64," + btoa("hello"), mime: "text/plain", name: "note.txt" })
    const out = await run(store.layer)(store.service.materialize(input))
    expect(out.path).toContain("/tmp/att-test/attachments/sess_1/")
    expect(out.size).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `attachment-store.ts`**

Key behavior:
- `MANAGED_DIRECTORY = "attachments"`, retention like `ToolOutputStore` (7d).
- `materialize`:
  - derive final MIME: `data:([^;,]+)` else `FSUtil.mimeType(target)` where `target = URL.canParse(uri) ? new URL(uri).pathname : (name ?? uri)`.
  - classify:
    - `data:` → base64 decode to `Uint8Array`.
    - `file://` → `LocationMutation.resolve({ path: pathname, kind: "file" })` then read bytes (read permission at admission). On error → return original.
    - `http(s)://` → `HttpClient` fetch, `filterStatusOk`, collect bytes. On error → return original.
    - else → return original.
  - write bytes to `path.join(directory, sessionID, '<id>.<ext>')` where `ext` from MIME via a small map; `id = Identifier.ascending("att")`.
  - return `{ ...attachment, path, size: bytes.length }`.
- `cleanup`: remove files older than retention (mirror `ToolOutputStore.cleanup`).
- Export a `test()` helper (or constructor) that accepts an override for `Global.data` + `sessionID` so tests avoid the real global dir.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add AttachmentStore materialization"`

---

### Task 3: Admit materialized attachments

**Files:**
- Modify: `packages/core/src/session.ts` (`V2Session.prompt` + node deps)
- Modify: `packages/core/src/session/input.ts` if needed (none expected)

**Interfaces:**
- `V2Session.prompt` enriches `resolvePrompt(input.prompt)` → `resolvePrompt(input.prompt, attachmentStore, sessionID)`.

- [ ] **Step 1: Write the failing test** (admit a prompt with a `data:` file; assert the admitted `Prompt.files[0].path` is set)

```ts
// packages/core/test/session-attachment.test.ts
// bootrapped with an in-memory Location + AttachmentStore; assert admitted prompt has materialized path.
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement**

In `V2Session.prompt`, before `resolvePrompt`, do:
```ts
const store = yield* AttachmentStore.Service
const files = input.prompt.files
  ? yield* Effect.forEach(input.prompt.files, (file) => store.materialize(file), { concurrency: 4 })
  : undefined
const prompt = resolvePrompt({ ...input.prompt, files })
```
Add `AttachmentStore.node` to the `node` deps array at the bottom of `session.ts`.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat(session): materialize attachments on prompt admission"`

---

### Task 4: Correct lowering in `to-llm-message`

**Files:**
- Modify: `packages/core/src/session/runner/to-llm-message.ts`
- Create: `packages/core/src/session/runner/to-llm-message.test.ts`

**Interfaces:**
- Replace `media()` with `contentFor(file: FileAttachment): ContentPart | ContentPart[]`:
  - media MIME → `{ type: "media", mediaType, data: <base64 from managed path bytes>, filename, metadata: description? }`.
  - text-like MIME + `path` → read text, inline as `{ type: "text", text: "<attachment name mime source>\n\n<text>" }` (bounded preview).
  - unavailable (no path) → `{ type: "text", text: "[attachment <name>: source unavailable]" }`.

- [ ] **Step 1: Write the failing test** (text attachment with path → inlined text part; image with managed path → media with base64; file:// without path → unavailable note)

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** (read bytes via `Bun.file(path).arrayBuffer()`, base64 via `Buffer`; text via `Bun.file(path).text()` with bounded preview helper). Import `FSUtil`/`Bun` as needed.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "fix(session): lower attachments as media bytes or inlined text"`

---

### Task 5: `core/attachments` awareness Context Source

**Files:**
- Create: `packages/core/src/attachment-awareness.ts`
- Create: `packages/core/src/attachment-awareness.test.ts`
- Modify: `packages/core/src/system-context/builtins.ts` (deps)

**Interfaces:**
- Registers `SystemContext.make({ key: "core/attachments", ... })` whose `load` reads projected `user` messages via `SessionProjector`, flattens `files`, and emits inventory rows.

- [ ] **Step 1: Write the failing test** (session with one materialized attachment → baseline text lists it with path/size)
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** `attachment-awareness.ts` mirroring `system-context/builtins.ts` registration; add `SessionProjector.node` to `builtins.ts` deps (global node).
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): add core/attachments awareness context source"`

---

### Task 6: `attachment` tool (`list` / `save`)

**Files:**
- Create: `packages/core/src/tool/attachment.ts`
- Create: `packages/core/src/tool/attachment.test.ts`
- Modify: `packages/core/src/tool/builtins.ts` (import + add `AttachmentTool.node` to `node` deps)

**Interfaces:**
- `attachment` tool, input discriminated on `action`:
  - `list` → inventory (same rows as Task 5) for the session.
  - `save: { id, path }` → `AttachmentStore.copyTo({ sessionID, id, target })`, gated by `edit` permission via `LocationMutation`.

- [ ] **Step 1: Write the failing test** (`list` returns inventory; `save` writes bytes to workspace path and fails on missing id)
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** `attachment.ts` (uses `SessionProjector`, `AttachmentStore`, `LocationMutation`, `PermissionV2`). Add `copyTo` to `AttachmentStore` (`path` resolve + read source bytes from managed path + write target via `FileMutation`/binary, with external-directory permission when outside location).
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat(tool): add attachment list/save tool"`

---

### Task 7: Wire location services & typecheck

**Files:**
- Modify: `packages/core/src/location-services.ts` (add `AttachmentStore.node`, `AttachmentAwareness.node` if global; ensure `BuiltInTools.node` includes attachment tool)
- Modify: `packages/core/src/session.ts` node deps (done in Task 3)

- [ ] **Step 1: Run `cd packages/core && bun typecheck`** — fix all errors.
- [ ] **Step 2: Run the new tests** — `cd packages/core && bun test attachment attachment-store to-llm-message attachment-awareness`
- [ ] **Step 3: Commit** — `git commit -m "chore(core): wire attachment store, awareness, and tool"`

---

### Task 8: Docs & PR

- [ ] **Step 1:** Update `specs/v2/session.md` row for "File, directory, media, and MCP-resource materialization" status → note materialization now covers prompt attachments (file/data/remote); MCP-resource deferred. Update `specs/v2/todo.md` line 136 to mark the attachment-source item addressed.
- [ ] **Step 2:** `git commit -m "docs: record attachment materialization status"`
- [ ] **Step 3:** Push branch `arena/01a02777-alphacode` and open PR against `dev` describing the design, coverage, and test evidence.
