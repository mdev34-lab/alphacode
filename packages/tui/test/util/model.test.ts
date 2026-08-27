import { describe, expect, test } from "bun:test"
import { get, modelSwitch, parse, supportsVision } from "../../src/util/model"
import type { Provider } from "@opencode-ai/sdk/v2"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  describe("supportsVision", () => {
    test("returns true for model with input.image capability", () => {
      const model = {
        capabilities: {
          input: { text: true, audio: false, image: true, video: false, pdf: false },
        },
      }
      expect(supportsVision(model)).toBe(true)
    })

    test("returns true for model with input.image capability even when attachment is false", () => {
      const model = {
        capabilities: {
          attachment: false,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
        },
      }
      expect(supportsVision(model)).toBe(true)
    })

    test("returns false for text-only model with input.image set to false", () => {
      const model = {
        capabilities: {
          attachment: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
        },
      }
      expect(supportsVision(model)).toBe(false)
    })

    test("returns true for model with array input containing image", () => {
      const model = {
        capabilities: {
          input: ["text", "image"],
        },
      }
      expect(supportsVision(model)).toBe(true)
    })

    test("returns false for model with array input containing only text", () => {
      const model = {
        capabilities: {
          input: ["text"],
        },
      }
      expect(supportsVision(model)).toBe(false)
    })

    test("returns false for undefined or null model", () => {
      expect(supportsVision(undefined)).toBe(false)
      expect(supportsVision(null)).toBe(false)
    })

    test("returns false when capabilities are missing or incomplete", () => {
      expect(supportsVision({})).toBe(false)
      expect(supportsVision({ capabilities: {} })).toBe(false)
      expect(supportsVision({ capabilities: { input: [] } })).toBe(false)
      expect(supportsVision({ capabilities: { input: {} } })).toBe(false)
    })

    test("resolves vision capability when combined with get() lookup", () => {
      const providers = [
        {
          id: "prov-a",
          name: "Provider A",
          source: "config" as const,
          env: [],
          options: {},
          models: {
            "model-vision": {
              id: "model-vision",
              providerID: "prov-a",
              api: { id: "model-vision", npm: "@ai-sdk/test", url: "http://test" },
              name: "Vision Model",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit: { context: 8000, output: 4000 },
              status: "active" as const,
              options: {},
              headers: {},
              release_date: "2026-01-01",
            },
            "model-text": {
              id: "model-text",
              providerID: "prov-a",
              api: { id: "model-text", npm: "@ai-sdk/test", url: "http://test" },
              name: "Text Model",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: false, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit: { context: 8000, output: 4000 },
              status: "active" as const,
              options: {},
              headers: {},
              release_date: "2026-01-01",
            },
          },
        },
      ] as Provider[]

      expect(supportsVision(get(providers, "prov-a", "model-vision"))).toBe(true)
      expect(supportsVision(get(providers, "prov-a", "model-text"))).toBe(false)
      expect(supportsVision(get(providers, "prov-a", "non-existent"))).toBe(false)
      expect(supportsVision(get(providers, "unknown-prov", "model-vision"))).toBe(false)
    })
  })

  test("marks a mid-task model switch on the turn that ran with the new model", () => {
    expect(
      modelSwitch(
        [{ parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" }],
        { parentID: "user", agent: "work", providerID: "provider", modelID: "model-b" },
      ),
    ).toEqual({ variant: undefined })
  })

  test("marks a thinking-effort switch on the same model", () => {
    expect(
      modelSwitch(
        [{ parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" }],
        { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a", variant: "high" },
      ),
    ).toEqual({ variant: "high" })
  })

  test("shows no marker when the configuration is unchanged", () => {
    expect(
      modelSwitch(
        [{ parentID: "user", agent: "work", providerID: "provider", modelID: "model-a", variant: "high" }],
        { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a", variant: "high" },
      ),
    ).toBeUndefined()
    expect(
      modelSwitch(
        [{ parentID: "user", agent: "work", providerID: "provider", modelID: "model-a", variant: "default" }],
        { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" },
      ),
    ).toBeUndefined()
  })

  test("shows no marker across user-message task boundaries", () => {
    expect(
      modelSwitch(
        [{ parentID: "user-a", agent: "work", providerID: "provider", modelID: "model-a" }],
        { parentID: "user-b", agent: "work", providerID: "provider", modelID: "model-b" },
      ),
    ).toBeUndefined()
  })

  test("interleaved subagent turns produce no marker and cannot hide a real switch", () => {
    const turns = [
      { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" },
      { parentID: "user", agent: "explore", providerID: "provider", modelID: "model-x" },
    ]
    // work/model-a -> explore/model-x: different agent, no marker
    expect(modelSwitch([turns[0]], turns[1])).toBeUndefined()
    // explore/model-x -> work/model-b: compares against the nearest
    // same-task/same-agent turn (work/model-a), so the real switch still
    // shows and the subagent model difference is skipped
    expect(
      modelSwitch(turns, { parentID: "user", agent: "work", providerID: "provider", modelID: "model-b" }),
    ).toEqual({ variant: undefined })
    // no switch at all after the subagent: no marker
    expect(
      modelSwitch(turns, { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" }),
    ).toBeUndefined()
  })

  test("shows no marker for the first turn", () => {
    expect(
      modelSwitch(undefined, { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" }),
    ).toBeUndefined()
    expect(
      modelSwitch([], { parentID: "user", agent: "work", providerID: "provider", modelID: "model-a" }),
    ).toBeUndefined()
  })
})
