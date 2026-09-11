/**
 * Native Qwen Web provider (`https://chat.qwen.ai/`).
 *
 * AlphaCode talks to the normal Qwen web app through the user's own
 * authenticated browser session: generations run on fresh ephemeral chats
 * via page-context fetch, and responses stream back incrementally through a
 * browser binding bridge. No API keys, no OAuth client secrets.
 *
 * Module layout:
 * - `constants` / `errors` / `log` — shared vocabulary.
 * - `protocol` — endpoints, payloads, SSE parsing (mirrors QwenProxy concepts).
 * - `prompt` — AI SDK prompt rendering + tool manifest instructions.
 * - `tool-parser` — streaming `<qw_call>` tool-call extraction.
 * - `browser` — Patchright persistent-profile lifecycle + auth detection.
 * - `transport` — page-context JSON + multiplexed streaming requests.
 * - `session` — chat creation / generation start / upstream stop.
 * - `upload` — STS + OSS multimodal uploads.
 * - `catalog` — live `/api/models` mapping + fallback + cache.
 * - `sdk` — `LanguageModelV3` implementation.
 * - `plugin` — AlphaCode auth/provider plugin hooks.
 */
export * from "@opencode-ai/webchat/adapters/qwen/constants"
export * from "@opencode-ai/webchat/adapters/qwen/errors"
export * from "@opencode-ai/webchat/adapters/qwen/log"
export * from "@opencode-ai/webchat/adapters/qwen/protocol"
export * from "./prompt"
export * from "@opencode-ai/webchat/adapters/qwen/tool-parser"
export * from "@opencode-ai/webchat/adapters/qwen/browser"
export * from "@opencode-ai/webchat/adapters/qwen/transport"
export * from "@opencode-ai/webchat/adapters/qwen/session"
export * from "@opencode-ai/webchat/adapters/qwen/upload"
export * from "./catalog"
export * from "./sdk"
export * from "./plugin"

import { QWEN_WEB_AUTH_MARKER, QWEN_WEB_PROVIDER_ID } from "@opencode-ai/webchat/adapters/qwen/constants"
import { readProfileMetadata, sharedBrowser } from "@opencode-ai/webchat/adapters/qwen/browser"

export interface QwenWebStoredAuth {
  type: string
  key?: string
  metadata?: Record<string, string>
}

/** True when the stored auth record belongs to a Qwen browser login. */
export function isQwenWebAuthRecord(auth: QwenWebStoredAuth | undefined): boolean {
  if (!auth || auth.type !== "api") return false
  return auth.key === QWEN_WEB_AUTH_MARKER
}

/**
 * Autoload gate for the provider's custom loader: load `qwen-web` only when
 * there is explicit evidence it was set up — a stored login, an
 * authenticated browser profile, or explicit user configuration. This keeps
 * the provider invisible (and cost-free) for everyone else.
 */
export function shouldAutoloadQwenWeb(input: { auth: QwenWebStoredAuth | undefined; hasConfig: boolean }): boolean {
  if (input.hasConfig) return true
  if (isQwenWebAuthRecord(input.auth)) return true
  try {
    return readProfileMetadata()?.authenticated === true
  } catch {
    return false
  }
}

/** Provider id constant re-export for wiring code. */
export const QWEN_WEB_ID = QWEN_WEB_PROVIDER_ID

/** Shut down shared Qwen Web resources (browser, transports). */
export async function disposeQwenWeb(): Promise<void> {
  await sharedBrowser()
    .close()
    .catch(() => {})
}
