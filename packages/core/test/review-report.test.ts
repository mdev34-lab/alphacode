/**
 * Regression tests for the Review subagent's parseable final report envelope.
 *
 * See packages/core/src/review-report.ts for the contract and
 * packages/opencode/src/agent/prompt/review.txt for the emitted shape.
 */

import { describe, expect, test } from "bun:test"
import { ReviewReport } from "@opencode-ai/core/review-report"
import { parseReviewVerdict } from "@opencode-ai/core/review-loop"

const report: ReviewReport.Info = {
  version: 1,
  revision: "a1b2c3d..e4f5a6b",
  assessment: "needs-fixes",
  summary: "The error path swallows failures.",
  findings: [
    {
      severity: "important",
      title: "Swallowed error",
      file: "src/parse.ts",
      line: 42,
      detail: "The catch block drops the cause; propagate it.",
    },
    { severity: "minor", title: "Naming", file: "src/parse.ts", detail: "Prefer `cause` over `e`." },
  ],
}

function envelope(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = report) {
  return `<alphacode-review>\n${JSON.stringify({ ...body, ...overrides }, null, 2)}\n</alphacode-review>`
}

const delivered = ReviewReport.extract([`### Issues\n\n- Important: swallowed error\n\n${envelope()}`])

describe("review report extraction", () => {
  test("1. normal review with one report envelope", () => {
    expect(delivered.ok).toBe(true)
    if (!delivered.ok) return
    expect(delivered.report).toEqual(report)
    expect(delivered.analysis).toBe("### Issues\n\n- Important: swallowed error")
  })

  test("2. multiple text parts followed by an empty text part still deliver the report", () => {
    const delivery = ReviewReport.extract([`Analysis\n\n${envelope()}`, "", "   "])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("needs-fixes")
    expect(delivery.analysis).toBe("Analysis")
  })

  test("3. report appearing before the final text part is found in the complete output", () => {
    const delivery = ReviewReport.extract(["Preamble.", envelope(), "Closing observations."])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(report)
    expect(delivery.analysis).toBe("Preamble.\n\nClosing observations.")
  })

  test("4. missing report envelope is an explicit delivery failure", () => {
    const delivery = ReviewReport.extract(["Looks good overall.", ""])
    expect(delivery.ok).toBe(false)
    if (delivery.ok) return
    expect(delivery.failure.reason).toBe("missing")
  })

  test("5. malformed report envelope is an explicit delivery failure", () => {
    const notJson = ReviewReport.extract([`<alphacode-review>not json at all</alphacode-review>`])
    expect(notJson.ok).toBe(false)
    if (!notJson.ok) expect(notJson.failure.reason).toBe("malformed")

    const truncated = ReviewReport.extract([`<alphacode-review>\n{"version": 1}\n`])
    expect(truncated.ok).toBe(false)
    if (!truncated.ok) expect(truncated.failure.reason).toBe("malformed")

    const wrongShape = ReviewReport.extract([envelope({}, { version: 1, revision: "x", assessment: "maybe" })])
    expect(wrongShape.ok).toBe(false)
    if (!wrongShape.ok) expect(wrongShape.failure.reason).toBe("malformed")
  })

  test("6. valid review with zero findings", () => {
    const delivery = ReviewReport.extract([
      envelope({}, { ...report, assessment: "approved", summary: "Nothing to report.", findings: [] }),
    ])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("approved")
    expect(delivery.report.findings).toEqual([])
  })

  test("7. long human-readable analysis around the report is preserved", () => {
    const analysis = `${"Detailed analysis.\n\n".repeat(40)}### Assessment\n\nAssessment: Needs fixes`
    const delivery = ReviewReport.extract([`${analysis}\n\n${envelope()}`, "postscript"])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.analysis).toContain("Detailed analysis.")
    expect(delivery.analysis).toContain("Assessment: Needs fixes")
    expect(delivery.analysis).toContain("postscript")
    expect(delivery.analysis).not.toContain("<alphacode-review>")
    expect(delivery.report).toEqual(report)
  })

  test("8. unknown or older report schema versions are rejected clearly", () => {
    const newer = ReviewReport.extract([envelope({ version: 2 })])
    expect(newer.ok).toBe(false)
    if (!newer.ok) {
      expect(newer.failure.reason).toBe("schema")
      expect(newer.failure.message).toContain("version 2")
      expect(newer.failure.message).toContain("version 1")
    }

    const legacy = ReviewReport.extract([envelope({ version: 0 })])
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.failure.reason).toBe("schema")

    const unversioned = ReviewReport.extract([envelope({ version: undefined }, { ...report, version: undefined })])
    expect(unversioned.ok).toBe(false)
    if (!unversioned.ok) expect(unversioned.failure.reason).toBe("malformed")
  })

  test("the last complete envelope wins when several are present", () => {
    const delivery = ReviewReport.extract([envelope({}, { ...report, assessment: "approved" }), envelope()])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report.assessment).toBe("needs-fixes")
  })

  test("tolerates extra properties a model adds to the report", () => {
    const delivery = ReviewReport.extract([envelope({ specCompliance: "issues", notes: "extra context" })])
    expect(delivery.ok).toBe(true)
    if (!delivery.ok) return
    expect(delivery.report).toEqual(report)
  })
})

describe("review report rendering", () => {
  test("rendered output round-trips through extraction and keeps the analysis", () => {
    expect(delivered.ok).toBe(true)
    if (!delivered.ok) return
    const rendered = ReviewReport.render(delivered)
    const parsed = ReviewReport.extract([rendered])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.report).toEqual(delivered.report)
    expect(parsed.analysis).toBe(delivered.analysis)
  })

  test("delivery failure messages are explicit and preserve a bounded analysis", () => {
    const message = ReviewReport.failureMessage({
      sessionID: "ses_review",
      failure: { reason: "missing", message: "no <alphacode-review> report envelope was found" },
      analysis: "x".repeat(2000),
    })
    expect(message).toContain("Review delivery failed")
    expect(message).toContain("ses_review")
    expect(message).toContain("Re-dispatch the review")
    expect(message).toContain("[truncated]")
    expect(message.length).toBeLessThan(2000)
  })
})

describe("verdict parsing with the report envelope", () => {
  test("the envelope assessment is canonical over contradicting prose", () => {
    const contradictory = ReviewReport.extract([
      "Assessment: Approved\n\nFollow-up issues remain.\n\n" +
        envelope({}, { ...report, assessment: "approved", findings: [] }),
    ])
    expect(contradictory.ok).toBe(true)
    expect(
      parseReviewVerdict(
        `Assessment: Needs fixes\n\n${envelope({}, { ...report, assessment: "approved", findings: [] })}`,
      ),
    ).toBe("approved")
  })

  test("prose reports without an envelope keep the tolerant fallback", () => {
    expect(parseReviewVerdict("### Assessment\n\n**Ready to proceed?** Approved")).toBe("approved")
    expect(parseReviewVerdict("- Verdict — Needs fixes")).toBe("needs-fixes")
    expect(parseReviewVerdict("The implementation looks good, but no final assessment was emitted.")).toBeUndefined()
  })
})
