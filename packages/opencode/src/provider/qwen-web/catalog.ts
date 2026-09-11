/**
 * Model catalog for the Qwen Web provider.
 *
 * The live `GET /api/models` catalog is authoritative; these helpers map it
 * onto AlphaCode's model representation. Until the first authenticated fetch
 * succeeds, a small static fallback keeps the model picker usable. Live
 * results are cached on disk (TTL) so restarts stay fast and offline-safe.
 *
 * Deliberately no model-name table: Qwen can add/remove models without an
 * AlphaCode release, and the live catalog picks that up automatically.
 */
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Model as ProviderModel, Info as ProviderInfo } from "../provider"
import { QWEN_WEB_DEFAULTS, QWEN_WEB_PROVIDER_ID, QWEN_WEB_SDK_NPM } from "@opencode-ai/webchat/adapters/qwen/constants"
import { debug } from "@opencode-ai/webchat/adapters/qwen/log"
import {
  normalizeModelRecord,
  parseModelsResponse,
  qwenWebBaseUrl,
  type QwenWebModelRecord,
} from "@opencode-ai/webchat/adapters/qwen/protocol"
import { QwenWebTransport, sharedTransport } from "@opencode-ai/webchat/adapters/qwen/transport"

export interface MappedCapabilities {
  reasoning: boolean
  canSkipThinking: boolean
  vision: boolean
  audio: boolean
  video: boolean
  pdf: boolean
  context: number
  output: number
  active: boolean
}

const FALLBACK_CONTEXT = 131_072
const FALLBACK_OUTPUT = 16_384

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value
  }
  return undefined
}

function positiveFlag(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 0
    if (typeof value === "boolean") return value
  }
  return undefined
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function stringList(...values: unknown[]): string[] {
  const result: string[] = []
  const append = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) append(item)
      return
    }
    if (typeof value === "string") {
      for (const item of value.split(",")) {
        const normalized = item.trim().toLowerCase()
        if (normalized && !result.includes(normalized)) result.push(normalized)
      }
    }
  }
  for (const value of values) append(value)
  return result
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Derive AlphaCode-facing capabilities from a normalized catalog record. */
export function deriveCapabilities(record: QwenWebModelRecord, raw?: Record<string, unknown>): MappedCapabilities {
  const root = raw ?? {}
  const metadata = record.metadata
  const caps = record.capabilities
  const abilities = { ...recordOf(metadata["abilities"]), ...recordOf(root["abilities"]) }
  const thinkSkip = { ...recordOf(metadata["think_skip"]), ...recordOf(root["think_skip"]) }

  const modalities = stringList(
    root["modalities"],
    root["modality"],
    metadata["modalities"],
    metadata["modality"],
    caps["modalities"],
    record.modalities,
  )

  const supportsThinking =
    booleanValue(
      root["supports_thinking"],
      root["supportsThinking"],
      caps["thinking"],
      caps["supports_thinking"],
      metadata["thinking"],
    ) ??
    positiveFlag(abilities["thinking"]) ??
    // The web client always offers a thinking mode; default to true so
    // reasoning display works even when metadata omits the flag.
    true

  const vision =
    booleanValue(root["supports_vision"], root["supportsVision"], caps["vision"], caps["supports_vision"]) ??
    positiveFlag(abilities["vision"]) ??
    modalities.includes("image")

  const audio =
    booleanValue(root["supports_audio"], root["supportsAudio"], caps["audio"]) ?? modalities.includes("audio")

  const video =
    booleanValue(root["supports_video"], root["supportsVideo"], caps["video"]) ?? modalities.includes("video")

  const pdf =
    booleanValue(
      root["supports_document"],
      root["supportsDocument"],
      caps["document"],
      caps["pdf"],
      caps["pdf_input"],
    ) ??
    positiveFlag(abilities["document"]) ??
    modalities.includes("pdf")

  const canSkipThinking =
    supportsThinking &&
    (booleanValue(
      thinkSkip["enable"],
      root["can_skip_thinking"],
      root["canSkipThinking"],
      caps["can_skip_thinking"],
      caps["canSkipThinking"],
    ) ??
      true)

  const context =
    firstPositiveNumber(
      root["context_window"],
      root["contextWindow"],
      root["max_context_length"],
      metadata["max_context_length"],
      metadata["maxContextLength"],
      metadata["context_window"],
      metadata["contextWindow"],
      caps["max_context_length"],
      caps["context_window"],
      record.contextWindow,
    ) ?? FALLBACK_CONTEXT

  const output =
    firstPositiveNumber(
      root["max_output_tokens"],
      root["maxOutputTokens"],
      root["max_tokens"],
      metadata["max_output_tokens"],
      metadata["maxOutputTokens"],
      metadata["max_summary_generation_length"],
      metadata["maxSummaryGenerationLength"],
      metadata["max_generation_length"],
      metadata["maxGenerationLength"],
      caps["max_output_tokens"],
      caps["maxOutputTokens"],
    ) ?? FALLBACK_OUTPUT

  return {
    reasoning: supportsThinking,
    canSkipThinking,
    vision,
    audio,
    video,
    pdf,
    context,
    output,
    active: record.isActive ?? true,
  }
}

/** Reasoning variants: auto/thinking always; fast when thinking can be skipped. */
export function reasoningVariants(canSkipThinking: boolean): Record<string, Record<string, unknown>> {
  const variants: Record<string, Record<string, unknown>> = {
    auto: { reasoningMode: "auto", thinking: true },
    thinking: { reasoningMode: "thinking", thinking: true },
  }
  if (canSkipThinking) variants["fast"] = { reasoningMode: "fast", thinking: false }
  return variants
}

export function mapRecordToModel(record: QwenWebModelRecord, raw?: Record<string, unknown>): ProviderModel {
  const caps = deriveCapabilities(record, raw)
  return {
    id: ModelV2.ID.make(record.id),
    providerID: ProviderV2.ID.make(QWEN_WEB_PROVIDER_ID),
    api: { id: record.id, url: qwenWebBaseUrl(), npm: QWEN_WEB_SDK_NPM },
    name: record.name || record.id,
    family: record.id.split("-").slice(0, 2).join("-"),
    capabilities: {
      temperature: false,
      reasoning: caps.reasoning,
      attachment: caps.vision || caps.pdf,
      toolcall: true,
      input: { text: true, audio: caps.audio, image: caps.vision, video: caps.video, pdf: caps.pdf },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: caps.context, output: caps.output },
    status: caps.active ? "active" : "deprecated",
    options: {},
    headers: {},
    release_date: "",
    variants: reasoningVariants(caps.canSkipThinking),
  }
}

// ---------------------------------------------------------------------------
// Static fallback (pre-login only; the live catalog replaces it)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS: Array<{ id: string; name: string; reasoning: boolean; vision: boolean }> = [
  // Ids verified against `GET /api/models` on chat.qwen.ai (Sep 2026):
  // older ids (qwen3-max, qwen-plus, qwen-turbo ...) are retired upstream and
  // return `Not_Found: Model not found` on `/api/v2/chat/completions`.
  { id: "qwen3.8-max", name: "Qwen3.8 Max", reasoning: true, vision: false },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", reasoning: true, vision: false },
]

function fallbackRecords(): QwenWebModelRecord[] {
  const now = Date.now() / 1000
  return FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    created: now,
    contextWindow: FALLBACK_CONTEXT,
    isActive: true,
    modalities: model.vision ? ["text", "image"] : ["text"],
    capabilities: { thinking: model.reasoning, vision: model.vision },
    metadata: {},
  }))
}

export function fallbackModels(): Record<string, ProviderModel> {
  const models: Record<string, ProviderModel> = {}
  for (const record of fallbackRecords()) {
    models[record.id] = mapRecordToModel(record)
  }
  return models
}

// ---------------------------------------------------------------------------
// Disk cache + live refresh
// ---------------------------------------------------------------------------

function cacheFile(): string {
  return path.join(Global.Path.cache, "qwen-web", "models.json")
}

interface ModelsCacheFile {
  fetchedAt: number
  records: QwenWebModelRecord[]
}

export function readCachedRecords(): QwenWebModelRecord[] | undefined {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf8")
    const parsed = JSON.parse(raw) as ModelsCacheFile
    if (!parsed || !Array.isArray(parsed.records) || typeof parsed.fetchedAt !== "number") return undefined
    if (Date.now() - parsed.fetchedAt > QWEN_WEB_DEFAULTS.modelsCacheTtlMs) return undefined
    const records = parsed.records.flatMap((entry) => {
      const record = normalizeModelRecord(entry)
      return record ? [record] : []
    })
    return records.length > 0 ? records : undefined
  } catch {
    return undefined
  }
}

function writeCachedRecords(records: QwenWebModelRecord[]): void {
  try {
    const file = cacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), records } satisfies ModelsCacheFile), "utf8")
  } catch (error) {
    debug("catalog", "failed to write models cache (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Fetch the live catalog through the authenticated browser context. */
export async function refreshModels(
  transport?: QwenWebTransport,
  signal?: AbortSignal,
  opts?: { allowNavigate?: boolean },
): Promise<QwenWebModelRecord[]> {
  const client = transport ?? sharedTransport()
  const response = await client.requestJson("GET", "/api/models", {
    signal,
    ...(opts ? { allowNavigate: opts.allowNavigate } : {}),
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Model catalog request failed (HTTP ${response.status})`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(response.body)
  } catch {
    throw new Error("Model catalog returned invalid JSON")
  }
  const records = parseModelsResponse(payload)
  if (records.length === 0) throw new Error("Model catalog returned no usable models")
  writeCachedRecords(records)
  debug("catalog", `refreshed ${records.length} models from live catalog`)
  return records
}

/** Best-effort background refresh; never throws, never launches a browser. */
export function refreshModelsInBackground(isBrowserRunning: () => boolean): void {
  if (!isBrowserRunning()) return
  refreshModels(undefined, undefined, { allowNavigate: false }).catch((error) => {
    debug("catalog", "background refresh failed (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/** Current best-known models: live cache first, static fallback otherwise. */
export function currentModels(): Record<string, ProviderModel> {
  const cached = readCachedRecords()
  if (cached) {
    const models: Record<string, ProviderModel> = {}
    for (const record of cached) {
      const model = mapRecordToModel(record)
      // Skip explicitly inactive models so the picker stays clean.
      if (model.status === "deprecated") continue
      models[record.id] = model
    }
    if (Object.keys(models).length > 0) return models
  }
  return fallbackModels()
}

/**
 * Resolve a model id to an id the upstream catalog accepts.
 *
 * Exact matches pass through. A retired id — that is, a Qwen name from an
 * older family than the live catalog (e.g. `qwen3-max` / `qwen-plus` while
 * the catalog is at `qwen3.7-plus` / `qwen3.8-max`) — is mapped onto the
 * current model of the same naming tier. chat.qwen.ai rotates model names
 * each cycle, so this is deliberately a naming rule, not a hardcoded table:
 * newer-named ids and non-Qwen ids are returned unchanged so upstream still
 * gets the chance to reject them with its own message.
 */
export function resolveUpstreamModelId(modelId: string, knownIds?: string[]): string {
  const known = knownIds ?? Object.keys(currentModels())
  if (known.includes(modelId)) return modelId
  if (known.length === 0) return modelId
  const requested = modelFamilyVersion(modelId)
  const newest = knownNewestFamilyVersion(known)
  if (!requested || !newest || requested.major > newest.major || (requested.major === newest.major && requested.minor >= newest.minor)) {
    return modelId
  }
  const tier = tierOf(modelId)
  if (!tier) return modelId
  const sameTier = known.find((id) => tierOf(id) === tier)
  if (sameTier) return sameTier
  if (tier === "turbo" || tier === "flash") {
    // The fast tier no longer exists upstream; plus is its closest live
    // equivalent.
    const plus = known.find((id) => tierOf(id) === "plus")
    if (plus) return plus
  }
  return modelId
}

const MODEL_TIERS = new Set(["max", "plus", "pro", "turbo", "flash", "lite", "vl", "coder", "math", "instruct"])

function tierOf(modelId: string): string | undefined {
  const dash = modelId.lastIndexOf("-")
  if (dash === -1) return undefined
  const tier = modelId.slice(dash + 1)
  return MODEL_TIERS.has(tier) ? tier : undefined
}

function modelFamilyVersion(modelId: string): { major: number; minor: number } | undefined {
  if (!modelId.startsWith("qwen")) return undefined
  // Vision and code families must never be age-gated into a text tier: there is
  // no safe textual equivalent for `qwen-vl-max` or `qwen2.5-coder-32b`, so
  // they either resolve to a same-name live id or pass through unchanged.
  if (/-(vl|coder)(?=-|$)/.test(modelId)) return undefined
  const match = /^qwen(\d+)(?:\.(\d+))?/.exec(modelId)
  if (match) return { major: Number.parseInt(match[1], 10), minor: match[2] ? Number.parseInt(match[2], 10) : 0 }
  // Unversioned brand ids (`qwen-plus`, `qwen-turbo`) predate the
  // versioned families, so they count as an older family.
  return { major: 1, minor: 0 }
}

function knownNewestFamilyVersion(known: string[]): { major: number; minor: number } | undefined {
  let newest: { major: number; minor: number } | undefined
  for (const id of known) {
    const version = modelFamilyVersion(id)
    if (!version) continue
    if (!newest || version.major > newest.major || (version.major === newest.major && version.minor > newest.minor)) {
      newest = version
    }
  }
  return newest
}

/** Provider info injected into AlphaCode's provider catalog. */
export function providerInfo(): ProviderInfo {
  return {
    id: ProviderV2.ID.make(QWEN_WEB_PROVIDER_ID),
    name: "Qwen Chat (beta)",
    source: "custom",
    env: [],
    options: {},
    models: currentModels(),
  }
}
