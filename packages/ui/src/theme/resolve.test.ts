import { describe, expect, test } from "bun:test"
import { oc2Theme } from "./default-themes"
import { resolveThemeVariant } from "./resolve"

describe("resolveThemeVariant", () => {
  test("resolves the work agent token to brand white in both modes", () => {
    expect(resolveThemeVariant(oc2Theme.light, false)["icon-agent-work-base"]).toBe("#ffffff")
    expect(resolveThemeVariant(oc2Theme.dark, true)["icon-agent-work-base"]).toBe("#ffffff")
  })
})
