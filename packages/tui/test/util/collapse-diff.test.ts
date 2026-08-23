import { describe, expect, test } from "bun:test"
import { collapseDiff } from "../../src/util/collapse-diff"

const SMALL_DIFF = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 a
-b
+c`

describe("collapseDiff", () => {
  test("returns the diff unchanged when within the line budget", () => {
    const result = collapseDiff(SMALL_DIFF, 5)
    expect(result.overflow).toBe(false)
    expect(result.diff).toBe(SMALL_DIFF)
  })

  test("truncates a long single-hunk diff to the budget and rewrites the header", () => {
    const body = Array.from({ length: 20 }, (_, i) => `+added${i}`).join("\n")
    const longDiff = `--- a/file.ts
+++ b/file.ts
@@ -1,20 +1,20 @@
${body}`
    const result = collapseDiff(longDiff, 3)
    expect(result.overflow).toBe(true)
    const out = result.diff.split("\n")
    // preamble (2) + rewritten hunk header (1) + 3 body lines
    expect(out).toHaveLength(6)
    expect(out.slice(0, 2)).toEqual(["--- a/file.ts", "+++ b/file.ts"])
    // 0 removed, 3 added in the kept body
    expect(out[2]).toBe("@@ -1,0 +1,3 @@")
    expect(out.slice(3)).toEqual(["+added0", "+added1", "+added2"])
  })

  test("keeps whole hunks that fit and rewrites only the partial hunk", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,2 @@",
      " ctx1",
      " ctx2",
      "@@ -10,5 +10,5 @@",
      "-old",
      "+new",
      " ctx3",
      "-old2",
      "+new2",
    ].join("\n")
    const result = collapseDiff(diff, 3)
    expect(result.overflow).toBe(true)
    const out = result.diff.split("\n")
    // hunk1 (2 body lines) fits entirely; 1 line of budget left for hunk2
    expect(out).toEqual([
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,2 @@",
      " ctx1",
      " ctx2",
      "@@ -10,1 +10,0 @@",
      "-old",
    ])
  })

  test("counts context lines toward both sides when rewriting a header", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,5 +1,5 @@",
      " ctx",
      "-old1",
      "-old2",
      "+new1",
      "+new2",
    ].join("\n")
    const result = collapseDiff(diff, 2)
    expect(result.overflow).toBe(true)
    const out = result.diff.split("\n")
    // 2 kept body lines: " ctx" and "-old1" -> removed=2 (ctx+old1), added=1 (ctx)
    expect(out[2]).toBe("@@ -1,2 +1,1 @@")
    expect(out.slice(3)).toEqual([" ctx", "-old1"])
  })

  test("preserves a section heading after the hunk header", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,10 +1,10 @@ function foo",
      ...Array.from({ length: 10 }, (_, i) => `+a${i}`),
    ].join("\n")
    const result = collapseDiff(diff, 1)
    expect(result.overflow).toBe(true)
    expect(result.diff.split("\n")[2]).toBe("@@ -1,0 +1,1 @@ function foo")
  })

  test("falls back to plain line truncation for non-hunked input", () => {
    const result = collapseDiff("just\nsome\nplain\ntext\nhere", 2)
    expect(result.overflow).toBe(true)
    expect(result.diff).toBe("just\nsome\n…")
  })

  test("keeps the no-newline marker in the body without counting it in the header", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,4 +1,4 @@",
      "-oldlast",
      "\\ No newline at end of file",
      "+newlast",
      "\\ No newline at end of file",
    ].join("\n")
    const result = collapseDiff(diff, 2)
    expect(result.overflow).toBe(true)
    const out = result.diff.split("\n")
    // 2 kept body lines: the removal and its no-newline marker. The marker is
    // preserved (keeps the diff valid) but excluded from the rewritten counts.
    expect(out).toEqual([
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,1 +1,0 @@",
      "-oldlast",
      "\\ No newline at end of file",
    ])
  })
})
