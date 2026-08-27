import { expect, test } from "bun:test"
import { parseModel, recentModels, selectionUpdate } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("pushes a model update while a session is busy and the model differs", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-b", variant: undefined },
  })
})

test("pushes an update when only the thinking effort changed", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "high",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-a", variant: "high" },
  })
})

test("treats the stored default variant as no variant", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "default",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-a", variant: "default" },
  })
})

test("does not push while the session is idle or the selection already matches", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      busy: false,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "high",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "high" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      busy: true,
    }),
  ).toBeUndefined()
})
