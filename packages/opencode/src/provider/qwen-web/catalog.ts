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
import { QWEN_WEB_DEFAULTS, QWEN_WEB_PROVIDER_ID, QWEN_WEB_SDK_NPM } from "./constants"
import { debug } from "./log"
import { normalizeModelRecord, parseModelsResponse, qwenWebBaseUrl, type QwenWebModelRecord } from "./protocol"
import { QwenWebTransport, sharedTransport } from "./transport"

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
  { id: "qwen3-max", name: "Qwen3 Max", reasoning: true, vision: false },
  { id: "qwen-plus", name: "Qwen Plus", reasoning: true, vision: false },
  { id: "qwen-turbo", name: "Qwen Turbo", reasoning: false, vision: false },
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
export async function refreshModels(transport?: QwenWebTransport, signal?: AbortSignal): Promise<QwenWebModelRecord[]> {
  const client = transport ?? sharedTransport()
  const response = await client.requestJson("GET", "/api/models", { signal })
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
  refreshModels().catch((error) => {
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

/** Provider info injected into AlphaCode's provider catalog. */
export function providerInfo(): ProviderInfo {
  return {
    id: ProviderV2.ID.make(QWEN_WEB_PROVIDER_ID),
    name: "Qwen Web",
    source: "custom",
    env: [],
    options: {},
    models: currentModels(),
  }
}
