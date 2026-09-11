/**
 * Shared constants for the Qwen Web provider (`qwen-web`).
 *
 * The provider drives the normal Qwen web application at `chat.qwen.ai`
 * through a persistent Patchright Chromium context owned by the user.
 * It is intentionally distinct from any Qwen API / OAuth / quota path.
 */

export const QWEN_WEB_PROVIDER_ID = "qwen-web"

/** AI SDK `api.npm` discriminator. Resolved by a bundled factory, not npm. */
export const QWEN_WEB_SDK_NPM = "qwen-web"

/** Default web origin. Overridable for tests via `QWEN_WEB_BASE_URL`. */
export const QWEN_WEB_DEFAULT_BASE_URL = "https://chat.qwen.ai"

export const QWEN_WEB_PATHS = {
  home: "/",
  models: "/api/models",
  chatsNew: "/api/v2/chats/new",
  chatsList: "/api/v2/chats/?page=1&exclude_project=true",
  completions: "/api/v2/chat/completions",
  completionsStop: "/api/v2/chat/completions/stop",
  stsToken: "/api/v2/files/getstsToken",
} as const

/** Payload `version` sent on chat completions (mirrors the web client). */
export const QWEN_WEB_COMPLETION_VERSION = "2.1"

/** API client `version` header stamped on web traffic (mirrors the web client). */
export const QWEN_WEB_CLIENT_VERSION = "0.2.91"

/** UMID SDK `bx-v` stamp on the same traffic. */
export const QWEN_WEB_BX_V = "2.5.37"

/**
 * Sentinel argument passed to the page `evaluate` that collects browser
 * client-context headers (`user-agent`, `sec-ch-ua*`, `accept-language`).
 * The transport simply uses it as a marker; the test fake keys on it.
 */
export const QWEN_WEB_CLIENT_CONTEXT_ARG = "__alphacodeQwenClientContext"

/** Chat type used for text conversations. */
export const QWEN_WEB_CHAT_TYPE_TEXT = "t2t"

/**
 * Tool-call marker tags emitted in prompts and parsed from model output.
 *
 * The canonical tag deliberately does NOT contain the `tool_call` substring:
 * the upstream stream has been observed to filter/corrupt that token, while
 * short private tags pass through untouched. The parser additionally accepts
 * the legacy `<tool_call>` / `<tool_calls>` spellings for robustness.
 */
export const QWEN_WEB_TOOL_OPEN = "<qw_call>"
export const QWEN_WEB_TOOL_CLOSE = "</qw_call>"

/** Accepted open-tag names (canonical first, legacy after). */
export const QWEN_WEB_TOOL_OPEN_NAMES = ["qw_call", "tool_call", "tool_calls"] as const
/** Accepted close-tag names (canonical first, legacy after). */
export const QWEN_WEB_TOOL_CLOSE_NAMES = ["qw_call", "tool_call", "tool_calls", "tool"] as const

/** Binding name used for the page-context streaming bridge. */
export const QWEN_WEB_STREAM_BINDING = "__alphacodeQwenStream"
/** Page-global key holding in-flight AbortControllers, keyed by request id. */
export const QWEN_WEB_STREAM_ABORTERS_KEY = "__alphacodeQwenStreamAborters"

/** Marker credential stored in auth.json after a successful browser login. */
export const QWEN_WEB_AUTH_MARKER = "qwen-web-browser-session"

/** Subdirectory (under AlphaCode's data dir) holding the browser profile. */
export const QWEN_WEB_PROFILE_SUBDIR = "qwen-web/browser-profile"
/** Lock file guarding the persistent profile across processes. */
export const QWEN_WEB_PROFILE_LOCKFILE = "alphacode.lock"

export const QWEN_WEB_ENV = {
  /** Override the web origin (tests / proxies). */
  baseUrl: "QWEN_WEB_BASE_URL",
  /** `true` (default) runs Chromium headless; `false` shows the window. */
  headless: "QWEN_WEB_HEADLESS",
  /** Override the persistent browser profile directory. */
  profileDir: "QWEN_WEB_PROFILE_DIR",
  /** `temp` (default, ephemeral chats) or `thread` (persisted chats). */
  chatMode: "QWEN_WEB_CHAT_MODE",
  /** Tool protocol: `block` (default, marker-tag blocks) or `native` (local_mcp). */
  toolMode: "QWEN_WEB_TOOL_MODE",
  /** Enable verbose provider diagnostics (`1`/`true`). */
  debug: "QWEN_WEB_DEBUG",
  /** Per-request page-operation budget in ms. */
  pageTimeoutMs: "QWEN_WEB_PAGE_TIMEOUT_MS",
  /** Navigation budget in ms. */
  navigationTimeoutMs: "QWEN_WEB_NAVIGATION_TIMEOUT_MS",
  /** First response metadata budget in ms. */
  metadataTimeoutMs: "QWEN_WEB_METADATA_TIMEOUT_MS",
  /** Idle gap budget between stream chunks in ms. */
  idleTimeoutMs: "QWEN_WEB_IDLE_TIMEOUT_MS",
  /** Idle gap budget between stream chunks in ms while reasoning. */
  reasoningIdleTimeoutMs: "QWEN_WEB_REASONING_IDLE_TIMEOUT_MS",
  /** Max concurrent streams multiplexed on the browser page. */
  maxStreams: "QWEN_WEB_MAX_STREAMS",
} as const

export const QWEN_WEB_DEFAULTS = {
  headless: true,
  chatMode: "temp" as const,
  toolMode: "block" as const,
  pageTimeoutMs: 60_000,
  navigationTimeoutMs: 45_000,
  metadataTimeoutMs: 60_000,
  idleTimeoutMs: 180_000,
  reasoningIdleTimeoutMs: 180_000,
  maxStreams: 4,
  /** Model catalog cache TTL in ms. */
  modelsCacheTtlMs: 5 * 60_000,
  /** Login wait budget in ms. */
  loginTimeoutMs: 10 * 60_000,
  /** Profile-lock wait budget in ms when another process owns the profile. */
  profileLockTimeoutMs: 30_000,
  /** Max upload size in bytes (matches upstream guidance). */
  maxUploadBytes: 25 * 1024 * 1024,
} as const

export type QwenWebChatMode = "temp" | "thread"
export type QwenWebReasoningMode = "auto" | "thinking" | "fast"
export type QwenWebToolMode = "block" | "native"
