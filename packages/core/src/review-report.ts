export * as ReviewReport from "./review-report"

import { Option, Schema } from "effect"

/**
 * The Review subagent delivers its canonical result through a tagged,
 * machine-readable report envelope appended after its human-readable analysis:
 *
 * <alphacode-review>
 * { "version": 1, ... }
 * </alphacode-review>
 *
 * Delivery extracts this envelope from the complete child output instead of
 * trusting the last text part, which a trailing empty text part can erase.
 */

export const TAG = "alphacode-review"

/** Bumped only for breaking envelope changes; older versions are rejected clearly. */
export const VERSION = 1

export const Finding = Schema.Struct({
  severity: Schema.Literals(["critical", "important", "minor"]),
  title: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "ReviewFinding" })

export const Info = Schema.Struct({
  version: Schema.Literal(VERSION),
  /** The unit boundary that was reviewed: "uncommitted" or "<base>..<head>". */
  revision: Schema.String,
  assessment: Schema.Literals(["approved", "needs-fixes"]),
  summary: Schema.String,
  findings: Schema.Array(Finding),
}).annotate({ identifier: "ReviewReport" })

export type Finding = Schema.Schema.Type<typeof Finding>
export type Info = Schema.Schema.Type<typeof Info>

/** Why a completed review could not be delivered as a parseable report. */
export type Failure =
  | { reason: "missing"; message: string }
  | { reason: "malformed"; message: string }
  | { reason: "schema"; message: string }

export type Delivery = { ok: true; report: Info; analysis: string } | { ok: false; failure: Failure; analysis: string }

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString, { onExcessProperty: "ignore" })
const decodeReport = Schema.decodeUnknownOption(Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const SCHEMA_HINT =
  'expected {"version": 1, "revision": string, "assessment": "approved" | "needs-fixes", "summary": string, "findings": [{"severity": "critical" | "important" | "minor", "title": string, "file"?: string, "line"?: number, "detail"?: string}]}'

/**
 * Extract the canonical review report from the complete child output.
 *
 * Chunks are every text part plus the finish summary, in order, so a trailing
 * empty text part cannot erase a report delivered earlier. The last complete
 * envelope is canonical; the remaining text is returned as the human-readable
 * analysis. A review that completes without a parseable version-1 envelope is a
 * delivery failure, never an empty successful result.
 */
export function extract(chunks: readonly (string | undefined)[]): Delivery {
  const text = chunks.filter((chunk): chunk is string => typeof chunk === "string").join("\n")
  const matches = [...text.matchAll(new RegExp(`<${TAG}>([\\s\\S]*?)</${TAG}>`, "g"))]
  const last = matches.at(-1)
  if (!last) {
    const analysis = text.trim()
    if (text.includes(`<${TAG}>`))
      return {
        ok: false,
        analysis,
        failure: { reason: "malformed", message: `the <${TAG}> envelope has an opening tag but no closing tag` },
      }
    return { ok: false, analysis, failure: { reason: "missing", message: `no <${TAG}> report envelope was found` } }
  }

  const start = last.index ?? 0
  const analysis = [text.slice(0, start).trimEnd(), text.slice(start + last[0].length).trimStart()]
    .filter((part) => part.length > 0)
    .join("\n\n")

  const inner = (last[1] ?? "").trim()
  const parsed = Option.getOrUndefined(decodeJson(inner))
  if (!isRecord(parsed))
    return {
      ok: false,
      analysis,
      failure: { reason: "malformed", message: "the envelope content is not a JSON object" },
    }
  if (parsed.version === undefined)
    return {
      ok: false,
      analysis,
      failure: { reason: "malformed", message: 'the report is missing the required "version" field' },
    }
  if (parsed.version !== VERSION)
    return {
      ok: false,
      analysis,
      failure: {
        reason: "schema",
        message: `unknown report schema version ${JSON.stringify(parsed.version)}; this runtime supports version ${VERSION} only`,
      },
    }
  const report = Option.getOrUndefined(decodeReport(parsed))
  if (!report)
    return {
      ok: false,
      analysis,
      failure: {
        reason: "malformed",
        message: `the report does not match the version ${VERSION} review report schema: ${SCHEMA_HINT}`,
      },
    }
  return { ok: true, report, analysis }
}

/** The canonical envelope text for a report, as the reviewer is told to emit it. */
export function envelope(report: Info): string {
  return `<${TAG}>\n${JSON.stringify(report, null, 2)}\n</${TAG}>`
}

/**
 * Render a delivered review as the parent-facing output: the human-readable
 * analysis followed by the re-serialized canonical envelope, so the persisted
 * result always carries exactly one valid report.
 */
export function render(delivery: Extract<Delivery, { ok: true }>): string {
  return [delivery.analysis, envelope(delivery.report)].filter((part) => part.length > 0).join("\n\n")
}

const ANALYSIS_EXCERPT_LIMIT = 1200

/** The explicit parent-facing failure for a review that delivered no report. */
export function failureMessage(input: { sessionID: string; failure: Failure; analysis?: string }): string {
  const preview = input.analysis ? boundedExcerpt(input.analysis) : undefined
  return [
    `Review delivery failed: ${input.failure.message}.`,
    `The review session ${input.sessionID} completed without a parseable <${TAG}> report, so this is not a verdict and carries no approval.`,
    preview ? `Its analysis, preserved here in truncated form: ${preview}` : undefined,
    `Re-dispatch the review to obtain a parseable report.`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

function boundedExcerpt(analysis: string): string {
  const text = analysis.trim()
  return text.length <= ANALYSIS_EXCERPT_LIMIT ? text : `${text.slice(0, ANALYSIS_EXCERPT_LIMIT)}… [truncated]`
}
