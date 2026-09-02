export * as ContextSettings from "./settings"

import type { Config } from "../config"
import { ContextProtection } from "./protection"
import type { Settings } from "./types"

export const defaults: Settings = {
  compression: {
    enabled: true,
    mode: "range",
    automatic: true,
    minContext: 0.6,
    maxContext: 0.85,
    timeoutMillis: 90_000,
  },
  deduplication: { enabled: true },
  purgeErrors: { enabled: true, turns: 4 },
  protection: ContextProtection.defaultPolicy,
  payloadBytes: undefined,
}

/** Fold every configuration document into one resolved context policy. */
export const settings = (documents: readonly Config.Entry[]): Settings =>
  documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.context ? [entry.info.context] : []))
    .reduce<Settings>(
      (result, current) => ({
        compression: {
          enabled: current.dynamic_compression?.enabled ?? result.compression.enabled,
          mode: current.dynamic_compression?.mode ?? result.compression.mode,
          automatic: current.dynamic_compression?.automatic ?? result.compression.automatic,
          minContext: current.dynamic_compression?.min_context ?? result.compression.minContext,
          maxContext: current.dynamic_compression?.max_context ?? result.compression.maxContext,
          timeoutMillis: current.dynamic_compression?.timeout_ms ?? result.compression.timeoutMillis,
        },
        deduplication: { enabled: current.deduplication?.enabled ?? result.deduplication.enabled },
        purgeErrors: {
          enabled: current.purge_errors?.enabled ?? result.purgeErrors.enabled,
          turns: current.purge_errors?.turns ?? result.purgeErrors.turns,
        },
        protection: {
          // Accumulate across documents: a workspace file that protects one tool must not discard
          // what the user file protected, and the built-in list is already in `result`.
          tools: current.protection?.tools
            ? [...new Set([...result.protection.tools, ...current.protection.tools])]
            : result.protection.tools,
          filePatterns: current.protection?.files
            ? [...new Set([...result.protection.filePatterns, ...current.protection.files])]
            : result.protection.filePatterns,
          messageTypes: result.protection.messageTypes,
          recentTurns: current.protection?.recent_turns ?? result.protection.recentTurns,
          userMessages: current.protection?.user_messages ?? result.protection.userMessages,
        },
        payloadBytes: current.payload_bytes ?? result.payloadBytes,
      }),
      defaults,
    )
