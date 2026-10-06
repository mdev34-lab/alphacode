import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { ToolFailure } from "@opencode-ai/llm"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { Truncate } from "./truncate"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const DEFAULT_LIMIT = 2000 // mirrors read's DEFAULT_READ_LIMIT
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start returning content from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: `The maximum number of lines to return (defaults to ${DEFAULT_LIMIT})`,
  }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

type Metadata = {
  truncated?: boolean
  outputPath?: string
}

export const WebFetchTool = Tool.define<typeof Parameters, Metadata, HttpClient.HttpClient | Truncate.Service>(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const truncate = yield* Truncate.Service

    const fetchContent = Effect.fn("WebFetchTool.fetch")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://")
      }

      yield* ctx.ask({
        permission: "webfetch",
        patterns: [params.url],
        always: ["*"],
        metadata: {
          url: params.url,
          format: params.format,
          timeout: params.timeout,
        },
      })

      const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

      // Build Accept header based on requested format with q parameters for fallbacks
      let acceptHeader = "*/*"
      switch (params.format) {
        case "markdown":
          acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
          break
        case "text":
          acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
          break
        case "html":
          acceptHeader =
            "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
          break
        default:
          acceptHeader =
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
      }
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Accept: acceptHeader,
        "Accept-Language": "en-US,en;q=0.9",
      }

      const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

      // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
      const response = yield* httpOk.execute(request).pipe(
        Effect.catchIf(
          (err) =>
            err.reason._tag === "StatusCodeError" &&
            err.reason.response.status === 403 &&
            err.reason.response.headers["cf-mitigated"] === "challenge",
          () =>
            httpOk.execute(
              HttpClientRequest.get(params.url).pipe(
                HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
              ),
            ),
        ),
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
      )

      // Check content length
      const contentLength = response.headers["content-length"]
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }

      const arrayBuffer = yield* response.arrayBuffer
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }

      const contentType = response.headers["content-type"] || ""
      const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
      const title = `${params.url} (${contentType})`

      if (isImageAttachment(mime)) {
        const base64Content = Buffer.from(arrayBuffer).toString("base64")
        return {
          kind: "image" as const,
          output: {
            title,
            output: "Image fetched successfully",
            metadata: {},
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${base64Content}`,
              },
            ],
          },
        }
      }

      const content = new TextDecoder().decode(arrayBuffer)

      // Handle content based on requested format and actual content type
      const converted = (() => {
        switch (params.format) {
          case "markdown":
            if (contentType.includes("text/html")) return convertHTMLToMarkdown(content)
            return content

          case "text":
            if (contentType.includes("text/html")) return extractTextFromHTML(content)
            return content

          default:
            return content
        }
      })()

      return { kind: "text" as const, converted, title }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const fetched = yield* fetchContent(params, ctx).pipe(Effect.orDie)
          if (fetched.kind === "image") return fetched.output

          // Windowing applies to the converted content so `offset` means the
          // same line for every format. Both params are NonNegativeInt like
          // `read`'s, so normalise the low end: 0 must not produce a reversed
          // or empty window.
          const windowed = windowContent(
            fetched.converted,
            Math.max(1, params.offset ?? 1),
            Math.max(1, params.limit ?? DEFAULT_LIMIT),
          )
          if (!windowed.ok) return yield* Effect.fail(new ToolFailure({ message: windowed.message }))
          if (!windowed.truncated && params.offset === undefined && params.limit === undefined) {
            // Same body and shape as before paging existed: the generic wrapper
            // still gets to observe it if it ever exceeds its own caps.
            return { output: fetched.converted, title: fetched.title, metadata: {} }
          }
          // A window that fits the caps was already bounded here, so the generic
          // wrapper should not re-truncate it and add a second, conflicting notice.
          if (!windowed.truncated)
            return { output: windowed.output, title: fetched.title, metadata: { truncated: false } }

          // The generic tool wrapper stops spilling oversized output as soon as a
          // tool reports its own `truncated` metadata, so a windowed fetch saves
          // the full converted body itself; otherwise the model could only
          // re-fetch and re-convert it.
          const saved = windowed.truncated ? yield* truncate.output(fetched.converted) : undefined
          const outputPath = saved && saved.truncated ? saved.outputPath : undefined
          return {
            output: outputPath ? `${windowed.output}\n\nFull output saved to: ${outputPath}` : windowed.output,
            title: fetched.title,
            metadata: windowed.truncated ? { truncated: true, ...(outputPath ? { outputPath } : {}) } : {},
          }
        }),
    }
  }),
)

function windowContent(content: string, offset: number, limit: number) {
  const lines = content.split(/\r?\n/)
  if (lines[lines.length - 1] === "") lines.pop()

  const count = lines.length
  const start = offset - 1
  if (start >= count && !(count === 0 && offset === 1)) {
    return { ok: false as const, message: `Offset ${offset} is out of range for this content (${count} lines)` }
  }

  const page: string[] = []
  let bytes = 0
  let cut = false
  for (const line of lines.slice(start)) {
    if (page.length >= limit) break
    const clipped = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line
    const size = Buffer.byteLength(clipped, "utf-8") + (page.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      cut = true
      break
    }
    page.push(clipped)
    bytes += size
  }

  const last = offset + page.length - 1
  const next = last + 1
  const more = start + page.length < count
  const notice = cut
    ? `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`
    : more
      ? `(Showing lines ${offset}-${last} of ${count}. Use offset=${next} to continue.)`
      : `(End of file - total ${count} lines)`

  return { ok: true as const, output: `${page.join("\n")}\n\n${notice}`, truncated: cut || more }
}

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
