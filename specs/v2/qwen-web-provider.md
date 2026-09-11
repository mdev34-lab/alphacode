# Qwen Web Provider (`qwen-web`)

Native AlphaCode provider for the normal Qwen web app at
`https://chat.qwen.ai/`. It drives the user's own authenticated browser
session through a persistent Patchright/Chromium profile and talks to the
same web endpoints the Qwen frontend uses. No API keys, no OAuth client
secrets, no Qwen Code quota.

## Scope

- Target is exactly `https://chat.qwen.ai/` (override for tests only via
  `QWEN_WEB_BASE_URL`).
- Qwen Code OAuth quota is explicitly out of scope for this provider.
- Chromium only, via Patchright. No Firefox/WebKit, no second browser
  abstraction. All browser code lives behind the small provider/browser
  transport layer in `packages/opencode/src/provider/qwen-web/`.
- The wire approach mirrors the concepts of
  `https://github.com/johngbl/QwenProxy` (persistent sessions, chat/session
  creation, streaming, reasoning, uploads, tool-call parsing, thread state,
  browser-context transport) and, secondarily,
  `https://github.com/pedrofariasx/qwenproxy` (lifecycle, discovery,
  streaming). No code is copied from either project.

## Architecture

```
AlphaCode session
  -> packages/opencode/src/provider/provider.ts   (catalog entry + custom loader)
  -> qwen-web/sdk.ts                              (LanguageModelV3)
  -> qwen-web/session.ts                          (chat create / generation / stop)
  -> qwen-web/transport.ts                        (page-context fetch + stream bridge)
  -> qwen-web/browser.ts                          (Patchright persistent profile)
  -> authenticated https://chat.qwen.ai page
```

Module layout (`src/provider/qwen-web/`):

| Module        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `constants`   | Provider id, origin, paths, tool tags, binding names, env, defaults   |
| `errors`      | `QwenWebError` taxonomy, `retryable` flags, classifiers               |
| `log`         | Debug logging with credential redaction                               |
| `protocol`    | Endpoint URLs, payload builders, SSE parsing, thinking summaries      |
| `prompt`      | AI SDK prompt rendering, media collection, tool manifest/instructions |
| `tool-parser` | Streaming `<qw_call>` extraction, JSON repair, per-turn caps          |
| `browser`     | Persistent-profile lifecycle, locks, login + auth detection           |
| `transport`   | `page.evaluate` JSON/fetch bridge, multiplexed streams, semaphore     |
| `session`     | Chat creation, generation start, upstream stop, stream consumption    |
| `upload`      | STS credentials + OSS upload for multimodal parts                     |
| `catalog`     | Live `/api/models` mapping, fallback list, TTL cache                  |
| `sdk`         | `LanguageModelV3` (`doGenerate`/`doStream`, warnings, cancellation)   |
| `plugin`      | AlphaCode auth/provider plugin hooks (browser login flow)             |

### AlphaCode wiring

- `src/provider/provider.ts`: imports the qwen-web entry, registers a
  bundled lazy loader (`"qwen-web": () => import("./qwen-web")`), injects
  `qwenWebProviderInfo()` into the provider catalog, and adds a custom
  model loader whose `autoload` gate is `shouldAutoloadQwenWeb`.
- `src/provider/transform.ts`: early return for qwen-web reasoning
  variants (reasoning travels as native thinking parts, not transforms).
- `src/plugin/index.ts`: registers `QwenWebAuthPlugin` in the internal
  plugin list.
- `src/server/routes/instance/httpapi/handlers/provider.ts`: includes
  qwen-web in provider discovery with enabled/disabled filtering.

### Autoload gate

The provider stays invisible and cost-free until there is explicit
evidence it was set up (`shouldAutoloadQwenWeb`):

1. explicit user config (`provider.qwen-web` block in `opencode.json`), or
2. a stored login record (marker `qwen-web-browser-session`), or
3. an authenticated browser profile on disk (`metadata.json`).

## Auth

Login happens in the real Qwen login page; AlphaCode never asks for or
stores Qwen passwords, MFA codes, CAPTCHA answers, or recovery codes.

Flow (`qwen-web/plugin.ts`, `qwen-web/browser.ts`):

1. `alphacode providers login` (or the TUI auth picker) invokes the
   `QwenWebAuthPlugin` authorize callback.
2. A headed Chromium window opens on the Qwen login page when no display
   is detected the flow predicts headed mode; an already-headless
   context flips to headed for the login step.
3. The user logs in normally in that window.
4. The provider polls lightweight auth probes until an authenticated
   session is detected (`waitForLogin`, 10-minute budget), then persists
   the profile and records the auth marker.
5. Subsequent runs reuse the persistent profile silently in headless mode.

Profile layout (under the AlphaCode data dir):

```
<data>/qwen-web/browser-profile/
  metadata.json   # { authenticated, userId?, savedAt }
  alphacode.lock  # cross-process lock (30s wait budget)
  <chromium files>
```

⚠️ **Security note: the browser profile IS credential material.** It contains the authenticated Qwen session (cookies, localStorage, sessionStorage). Anyone with filesystem access to `<data>/qwen-web/browser-profile/` can impersonate the Qwen session. Treat it as you would an API key or OAuth token. The lockfile (`alphacode.lock`) prevents concurrent corruption but does not protect against malicious local access.

Foreign navigations are healed: `ensureOnOrigin` steers stray pages back
to `https://chat.qwen.ai` before any request.

## Protocol

Base origin `https://chat.qwen.ai`, JSON over page-context `fetch`:

- `GET /api/models` — model discovery (mapped through `catalog.ts`).
- `POST /api/chats` (chat creation) and the chat-completion streaming
  endpoint, built by `protocol.ts` payload helpers
  (`QWEN_WEB_COMPLETION_VERSION = "2.1"`, chat type `t2t`).
- SSE responses are consumed incrementally through the stream bridge;
  cumulative `content` fields are diffed into deltas (`incrementalDelta`).
  A bare `FINISHED` sentinel ends the turn and is never emitted as text.
- Thinking/reasoning arrives as thinking summaries (`formatThinkingSummary`)
  and surfaces as native reasoning parts; reasoning variants bypass the
  generic provider transform layer.
- Generations run on fresh ephemeral chats by default
  (`QWEN_WEB_CHAT_MODE=temp`); `thread` mode reuses a persistent thread.
  **`thread` mode is explicit opt-in:** it shares the same upstream Qwen
  conversation across AlphaCode turns. This is intended for workflows that
  deliberately want to reuse Qwen's conversation memory; it is NOT the
  default because it can leak context between unrelated AlphaCode sessions
  using the same Qwen account.
- Cancellation propagates `AbortSignal` end to end: SDK -> session ->
  in-page `AbortController` registry plus an upstream stop request.

## Tool calling

Qwen web models have no native function-calling endpoint, so tools use a
text envelope:

- Manifest + instructions (`buildToolManifest`, `buildToolInstructions`)
  are rendered signature-style (`name(path: string, limit?: number) - …`)
  ahead of the transcript.
- The model emits `<qw_call>{"name": "...", "arguments": {...}}</qw_call>`
  blocks; legacy `tool_call`/`tool_calls`/`tool` spellings are also
  accepted.
- `tool-parser.ts` extracts blocks from the token stream (split-chunk
  assembly, unclosed-block recovery at flush, truncated-JSON completion,
  per-turn caps, unknown names preserved). Unparseable blocks are left in
  the visible text rather than dropped.
- Tool results render as `Tool Response (name): …` transcript turns; names
  resolve from history when a result omits them.

## Multimodal uploads

`qwen-web/upload.ts`: fetches STS credentials in page context, downloads
remote URLs, enforces the 25 MiB cap, and uploads bytes via `ali-oss`
(`putObject`). Abort signals cancel mid-upload; STS/auth failures map to
typed `session_expired` / `upstream_error` codes.

## Errors, retry, recovery

`QwenWebError` codes (selection): `aborted`, `browser_error`,
`session_expired`, `upstream_error`, `rate_limited`, `verification_required`,
`timeout`, `invalid_response`. Retryable errors carry `retryable: true`
and feed the standard retry path; page/context loss invalidates the page
so the next request rebuilds it. Rate limits surface as `rate_limited`
with upstream backoff hints preserved; human-verification challenges
surface as `verification_required` and pause automation until the user
resolves them in the profile window.

## Concurrency and performance

- One shared browser per process (`sharedBrowser`), one page per request
  context, stream slots serialized through a semaphore
  (`QWEN_WEB_MAX_STREAMS`, default 4). **Tunable via env var
  `QWEN_WEB_MAX_STREAMS`** — reduce to 1-2 if Qwen rate-limits or
  account limits are hit; increase only if the account quota allows.
- Idle contexts close after `QWEN_WEB_IDLE_TIMEOUT_MS` (default 3 min;
  10 min while reasoning streams).
- Model catalog caches for 5 minutes; thinking models keep longer idle
  budgets.

## Configuration

`opencode.json`:

```jsonc
{
  "provider": {
    "qwen-web": {
      // present => provider autoloads; per-model options under "models"
    },
  },
}
```

Model options: `reasoningMode` (`auto` | `thinking` | `fast`), `thinking`.

Environment:

| Variable                         | Default                | Purpose                         |
| -------------------------------- | ---------------------- | ------------------------------- |
| `QWEN_WEB_BASE_URL`              | `https://chat.qwen.ai` | Origin override (tests only)    |
| `QWEN_WEB_HEADLESS`              | `true`                 | Headless Chromium               |
| `QWEN_WEB_PROFILE_DIR`           | `<data>/qwen-web/...`  | Persistent profile location     |
| `QWEN_WEB_CHAT_MODE`             | `temp`                 | `temp` ephemeral chats/`thread` |
| `QWEN_WEB_DEBUG`                 | unset                  | Verbose redacted logging        |
| `QWEN_WEB_PAGE_TIMEOUT_MS`       | `60000`                | Page operation budget           |
| `QWEN_WEB_NAVIGATION_TIMEOUT_MS` | `45000`                | Navigation budget               |
| `QWEN_WEB_METADATA_TIMEOUT_MS`   | `60000`                | JSON request budget             |
| `QWEN_WEB_IDLE_TIMEOUT_MS`       | `180000`               | Idle context shutdown           |
| `QWEN_WEB_MAX_STREAMS`           | `4`                    | Concurrent stream slots (tunable; reduce if rate-limited) |

## Dependencies

`packages/opencode/package.json` (exact pins):

- `patchright` — stealth Chromium automation (persistent contexts).
- `ali-oss` — OSS upload client (ambient types in `ali-oss.d.ts`).
- `chromium-bidi@13.1.1` — satisfies patchright-core's lazy BiDi require
  so `Bun.build` can resolve it. v13 is the newest major keeping the
  legacy `lib/cjs/{bidiMapper/BidiMapper,cdp/CdpConnection}` paths;
  the BiDi path never executes (CDP-only usage).
- `proxy-agent@5.0.0` — urllib's (ali-oss) lazy peer require, same
  bundling rationale; also enables proxy env support at runtime.

Setup: `bunx patchright install chromium` once per machine. Without it,
any run fails fast with a typed setup error naming that command.

## Verification

Unit suite `packages/opencode/test/provider/qwen-web/` (12 files, 138
tests): errors, protocol, tool-parser, prompt, session, upload,
transport, catalog, browser, sdk, plugin, index — all passing with faked
pages, transports, streams, STS, and bindings.

Gates (all green on the feature branch):

- `bun test --timeout 30000 test/provider/qwen-web/` — 138 pass.
- Existing suites: provider/transform/error/model-status (514 pass),
  plugin + auth picker (182 pass) — no regressions.
- `tsc --noEmit` — zero errors (3 GiB heap; default-heap OOM is a
  pre-existing baseline, verified via `git stash`).
- `oxlint` — 0 errors; `prettier --check` — clean.
- `bun run script/build.ts --single --skip-install` (`Bun.build` with
  `compile:`) — bundles and the smoke test passes.
- Compiled-binary E2E: `models qwen-web` lists
  `qwen-plus`/`qwen-turbo`/`qwen3-max` with explicit config, and
  `run -m qwen-web/qwen-turbo` wires through loader -> model -> browser
  launch, failing only on the expected missing-Chromium setup error.

## Manual test plan (requires a user Qwen login)

1. `bunx patchright install chromium`.
2. `alphacode providers login`, pick Qwen Web, log in normally in the
   opened window; confirm the profile authenticates and persists.
3. `alphacode models qwen-web` shows live models after login.
4. `alphacode run -m qwen-web/qwen-turbo "say hi"` streams a reply.
5. Tool loop: ask it to read then edit a file; confirm `<qw_call>`
   round-trips and visible progress.
6. Attach an image; confirm STS upload + vision answer on a vision model.
7. Cancel mid-stream (Esc); confirm instant stop, no orphaned processes.
8. Revoke the web session in the browser, rerun; confirm a clear
   re-login prompt (no password handling) and recovery after login.
9. Rate-limit/verification: confirm typed pausing errors, not crashes.

## Security

- Secrets boundary: only the auth marker (not credentials) is stored by
  AlphaCode; cookies/tokens never leave the Chromium profile.
- Debug logs redact `token=`/`bearer`/cookie-shaped values.
- Uploads and page requests stay in first-party `chat.qwen.ai` context;
  no cookie exfiltration to server-side fetch.
- Lockfile prevents concurrent profile corruption across processes.

## Known limitations

- Web-protocol drift: Qwen may change endpoints/payloads; `protocol.ts`
  centralizes them and unknown SSE events are ignored defensively.
  **Monitoring:** watch for `verification_required` / `upstream_error` rate
  increases after Qwen web updates; unknown SSE event logs (`debug` level)
  indicate drift. Regression tests cover payload builders but not live
  endpoints.
- No headless CAPTCHA solving: verification pauses with a typed error.
- Single page per request context; high parallelism is intentionally
  capped by the stream semaphore.
