import { expect, test } from "bun:test"
import { BRAND_NAME, BRAND_PREFIX, BRAND_SUFFIX } from "../src/brand"

// Guards the sidebar footer wordmark against drifting back to the legacy
// "OpenCode" product name. The footer renders the two-tone inline mark from
// these constants (see routes/session/sidebar.tsx and feature-plugins/sidebar/footer.tsx).
test("product brand name is AlphaCode", () => {
  expect(BRAND_NAME).toBe("AlphaCode")
})

test("brand prefix and suffix compose the product name", () => {
  expect(BRAND_PREFIX + BRAND_SUFFIX).toBe(BRAND_NAME)
})

test("brand name is not the legacy OpenCode product identity", () => {
  expect(BRAND_NAME).not.toBe("OpenCode")
  expect(BRAND_NAME.toLowerCase()).not.toContain("opencode")
})
