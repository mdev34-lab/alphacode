/**
 * Webchat backbone: a provider-neutral layer for driving AI chat sites with
 * persistent server-side threaded conversations.
 *
 * - `types` — canonical thread, message, tool and turn-event model.
 * - `thread` — pure helpers for editing thread message lists.
 * - `store` — threads.json persistence so restarts reuse upstream chats.
 * - `provider` — `WebChatProvider` interface + adapter registry.
 *
 * Qwen Chat (the first adapter) lives under `adapters/qwen`.
 */
export * from "./types"
export * from "./thread"
export * from "./store"
export * from "./provider"
export * as WebChat from "."