import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import {
  currentModels,
  deriveCapabilities,
  fallbackModels,
  mapRecordToModel,
  providerInfo,
  readCachedRecords,
  reasoningVariants,
  refreshModels,
  resolveUpstreamModelId,
} from "@/provider/qwen-web/catalog"
import { normalizeModelRecord, type QwenWebModelRecord } from "@opencode-ai/webchat/adapters/qwen/protocol"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"

function cacheFile(): string {
  return path.join(Global.Path.cache, "qwen-web", "models.json")
}

function backupCache(): string | undefined {
  try {
    return fs.readFileSync(cacheFile(), "utf8")
  } catch {
    return undefined
  }
}

function restoreCache(backup: string | undefined): void {
  try {
    if (backup === undefined) fs.rmSync(cacheFile(), { force: true })
    else {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
      fs.writeFileSync(cacheFile(), backup, "utf8")
    }
  } catch {
    // Best effort: never fail tests on cleanup.
  }
}

afterEach(() => {
  restoreCache(undefined)
})

describe("deriveCapabilities", () => {
  function record(overrides: Partial<QwenWebModelRecord> = {}, raw: Record<string, unknown> = {}): MappedArgs {
    return {
      record: {
        id: "m",
        name: "M",
        created: 1,
        capabilities: {},
        metadata: {},
        ...overrides,
      },
      raw,
    }
  }
  interface MappedArgs {
    record: QwenWebModelRecord
    raw: Record<string, unknown>
  }

  test("reads thinking, vision and context signals", () => {
    const { record: rec, raw } = record(
      { contextWindow: 1234, modalities: ["text", "image"], capabilities: { thinking: true } },
      { supports_audio: true },
    )
    const caps = deriveCapabilities(rec, raw)
    expect(caps.reasoning).toBe(true)
    expect(caps.vision).toBe(true)
    expect(caps.audio).toBe(true)
    expect(caps.video).toBe(false)
    expect(caps.context).toBe(1234)
    expect(caps.canSkipThinking).toBe(true)
    expect(caps.active).toBe(true)
  })

  test("think_skip disabled removes the fast path", () => {
    const normalized = normalizeModelRecord({
      id: "qwq",
      metadata: { think_skip: { enable: false }, abilities: { thinking: 1 } },
    })!
    const caps = deriveCapabilities(normalized, { think_skip: { enable: false } })
    expect(caps.reasoning).toBe(true)
    expect(caps.canSkipThinking).toBe(false)
  })

  test("unknown models default to reasoning-capable with safe limits", () => {
    const caps = deriveCapabilities(record().record, {})
    expect(caps.reasoning).toBe(true)
    expect(caps.context).toBeGreaterThan(0)
    expect(caps.output).toBeGreaterThan(0)
    expect(caps.vision).toBe(false)
  })
})

describe("mapRecordToModel", () => {
  test("maps onto the AlphaCode model shape", () => {
    const model = mapRecordToModel({
      id: "qwen3-max",
      name: "Qwen3 Max",
      created: 1,
      contextWindow: 1000,
      isActive: true,
      modalities: ["text"],
      capabilities: { thinking: true },
      metadata: {},
    })
    expect(String(model.id)).toBe("qwen3-max")
    expect(String(model.providerID)).toBe("qwen-web")
    expect(model.api.npm).toBe("qwen-web")
    expect(model.api.url).toContain("chat.qwen.ai")
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.temperature).toBe(false)
    expect(model.cost.input).toBe(0)
    expect(model.limit.context).toBe(1000)
    expect(model.status).toBe("active")
    expect(Object.keys(model.variants ?? {}).sort()).toEqual(["auto", "fast", "thinking"])
  })

  test("inactive models map to deprecated", () => {
    const model = mapRecordToModel({
      id: "old",
      name: "Old",
      created: 1,
      isActive: false,
      capabilities: {},
      metadata: {},
    })
    expect(model.status).toBe("deprecated")
  })
})

describe("reasoningVariants", () => {
  test("fast is only offered when thinking can be skipped", () => {
    expect(Object.keys(reasoningVariants(true)).sort()).toEqual(["auto", "fast", "thinking"])
    expect(reasoningVariants(true)["fast"]).toMatchObject({ reasoningMode: "fast", thinking: false })
    expect(Object.keys(reasoningVariants(false)).sort()).toEqual(["auto", "thinking"])
  })
})

describe("fallbackModels and providerInfo", () => {
  test("fallback keeps the picker usable pre-login with live ids", () => {
    const models = fallbackModels()
    expect(Object.keys(models).length).toBeGreaterThanOrEqual(2)
    for (const model of Object.values(models)) {
      expect(String(model.providerID)).toBe("qwen-web")
      expect(model.api.npm).toBe("qwen-web")
    }
    // Retired ids must never be advertised; the current upstream catalog is
    // `qwen3.8-max` / `qwen3.7-plus` (verified against `GET /api/models`).
    const neverIds = ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max", "qwen3-plus", "qwen3-turbo"]
    for (const id of Object.keys(models)) {
      expect(neverIds).not.toContain(id)
    }
    const info = providerInfo()
    expect(String(info.id)).toBe("qwen-web")
    expect(info.name).toBe("Qwen Chat (beta)")
    expect(info.source).toBe("custom")
    expect(info.env).toEqual([])
  })
})

describe("resolveUpstreamModelId", () => {
  const live = ["qwen3.8-max", "qwen3.7-plus"]

  test("passes exact live ids through unchanged", () => {
    expect(resolveUpstreamModelId("qwen3.8-max", live)).toBe("qwen3.8-max")
    expect(resolveUpstreamModelId("qwen3.7-plus", live)).toBe("qwen3.7-plus")
  })

  test("maps retired ids onto the current equivalent tier", () => {
    expect(resolveUpstreamModelId("qwen3-max", live)).toBe("qwen3.8-max")
    expect(resolveUpstreamModelId("qwen3-plus", live)).toBe("qwen3.7-plus")
    expect(resolveUpstreamModelId("qwen-plus", live)).toBe("qwen3.7-plus")
    expect(resolveUpstreamModelId("qwen-turbo", live)).toBe("qwen3.7-plus")
  })

  test("does not remap newer-named or non-Qwen ids", () => {
    expect(resolveUpstreamModelId("qwen3.9-max", live)).toBe("qwen3.9-max")
    expect(resolveUpstreamModelId("gpt-4o", live)).toBe("gpt-4o")
    expect(resolveUpstreamModelId("qwen3-235b-a22b", live)).toBe("qwen3-235b-a22b")
  })

  test("never swaps vision/code models for a text model", () => {
    // No vl/coder line in the live catalog: pass through unchanged rather than
    // silently resolve to a text-tier model.
    expect(resolveUpstreamModelId("qwen-vl-max", live)).toBe("qwen-vl-max")
    expect(resolveUpstreamModelId("qwen3-vl-plus", live)).toBe("qwen3-vl-plus")
    expect(resolveUpstreamModelId("qwen2.5-coder-32b", live)).toBe("qwen2.5-coder-32b")
    // With an actual vl record present, an older vl id resolves within the vl
    // line only via exact match; it never reaches a text-tier remap.
    expect(resolveUpstreamModelId("qwen-vl-max", ["qwen3.8-max", "qwen-vl-max"])).toBe("qwen-vl-max")
    expect(resolveUpstreamModelId("qwen3-vl-plus", [...live, "qwen3.7-vl-plus"])).toBe("qwen3-vl-plus")
  })

  test("defaults to the current (cached or fallback) catalog", () => {
    const resolved = resolveUpstreamModelId("qwen3-max")
    expect(["qwen3.8-max", "qwen3.7-plus"]).toContain(resolved)
  })
})

describe("live catalog cache", () => {
  const backup = backupCache()

  test("refreshModels parses, caches and returns live records", async () => {
    const transport = {
      requestJson: (async () => ({
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: JSON.stringify({ data: [{ id: "live-model", name: "Live", metadata: { max_context_length: 777 } }] }),
      })) as QwenWebTransport["requestJson"],
    } as unknown as QwenWebTransport
    const records = await refreshModels(transport)
    expect(records.map((record) => record.id)).toEqual(["live-model"])
    expect(readCachedRecords()?.map((record) => record.id)).toEqual(["live-model"])
    expect(Object.keys(currentModels())).toEqual(["live-model"])
    expect(currentModels()["live-model"]?.limit.context).toBe(777)
    restoreCache(backup)
  })

  test("stale caches are ignored", () => {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        fetchedAt: Date.now() - 60 * 60_000,
        records: [{ id: "stale", name: "Stale", created: 1, capabilities: {}, metadata: {} }],
      }),
      "utf8",
    )
    expect(readCachedRecords()).toBeUndefined()
    expect(Object.keys(currentModels()).length).toBeGreaterThanOrEqual(2)
    restoreCache(backup)
  })

  test("corrupt caches fall back silently", () => {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), "{oops", "utf8")
    expect(readCachedRecords()).toBeUndefined()
    restoreCache(backup)
  })

  test("refresh failures throw without touching the cache", async () => {
    const transport = {
      requestJson: (async () => ({
        status: 500,
        statusText: "x",
        contentType: "text/plain",
        body: "nope",
      })) as QwenWebTransport["requestJson"],
    } as unknown as QwenWebTransport
    await expect(refreshModels(transport)).rejects.toThrow()
    expect(readCachedRecords()).toBeUndefined()
  })
})
