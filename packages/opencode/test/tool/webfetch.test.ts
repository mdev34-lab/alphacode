import { describe, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const layer = (cfg?: ConfigV1.Info) =>
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Config.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
    ...(cfg ? ([[Config.node, TestConfig.layer({ get: () => Effect.succeed(cfg) })]] as LayerNode.Replacements) : []),
  ])

const it = testEffect(layer())
const capped = testEffect(layer({ tool_output: { max_bytes: 10 * 1024 } }))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "work",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("returns the full body unchanged when offset and limit are omitted", () =>
    withFetch(
      () => new Response("alpha\nbeta\ngamma\n", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("alpha\nbeta\ngamma\n")
          expect(result.metadata.truncated).toBe(false)
        }),
    ),
  )

  it.instance("windows text output and states how to continue", () =>
    withFetch(
      () =>
        new Response("line1\nline2\nline3\nline4\nline5", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({
            url: new URL("/file.txt", url).toString(),
            format: "text",
            offset: 2,
            limit: 2,
          })
          expect(result.output).toContain("line2\nline3")
          expect(result.output).not.toContain("line1")
          expect(result.output).not.toContain("line4")
          expect(result.output).toContain("(Showing lines 2-3 of 5. Use offset=4 to continue.)")
          expect(result.metadata.truncated).toBe(true)
        }),
    ),
  )

  it.instance("saves the full converted body when the window leaves content out", () =>
    withFetch(
      () =>
        new Response(
          `<html><body>${Array.from({ length: 150 }, (_, i) => `<p>line${i + 1} ${"x".repeat(500)}</p>`).join("")}</body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({
            url: new URL("/page.html", url).toString(),
            format: "markdown",
            offset: 1,
            limit: 2,
          })
          const outputPath = result.metadata.outputPath
          if (typeof outputPath !== "string") throw new Error("expected metadata.outputPath to be a string")
          expect(result.output).toContain(`Full output saved to: ${outputPath}`)
          const saved = yield* Effect.promise(() => Bun.file(outputPath).text())
          expect(saved).toContain("line1 ")
          expect(saved).toContain("line150 ")
          expect(saved).not.toContain("Use offset=")
        }),
    ),
  )

  it.instance("clamps a zero limit instead of returning a reversed window", () =>
    withFetch(
      () => new Response("line1\nline2\nline3", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 2, limit: 0 })
          expect(result.output).toContain("(Showing lines 2-2 of 3. Use offset=3 to continue.)")
        }),
    ),
  )

  it.instance("strips carriage returns from CRLF bodies", () =>
    withFetch(
      () => new Response("line1\r\nline2\r\nline3\r\n", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/crlf.txt", url).toString(), format: "text", offset: 2, limit: 1 })
          expect(result.output).toBe("line2\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)")
        }),
    ),
  )

  it.instance("reports an empty body with an explicit offset as end of file", () =>
    withFetch(
      () => new Response("", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/empty.txt", url).toString(), format: "text", offset: 1 })
          expect(result.output).toBe("\n\n(End of file - total 0 lines)")
          expect(result.metadata.truncated).toBe(false)
        }),
    ),
  )

  it.instance("windows the final line when offset is exactly the last line", () =>
    withFetch(
      () => new Response("line1\nline2\nline3", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 3, limit: 5 })
          expect(result.output).toBe("line3\n\n(End of file - total 3 lines)")
          expect(result.metadata.truncated).toBe(false)
        }),
    ),
  )

  it.instance("uses the default limit when only offset is supplied", () =>
    withFetch(
      () => new Response("line1\nline2\nline3", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 2 })
          expect(result.output).toBe("line2\nline3\n\n(End of file - total 3 lines)")
        }),
    ),
  )

  it.instance("windows markdown after html conversion", () =>
    withFetch(
      () =>
        new Response("<h1>One</h1><p>Two</p><p>Three</p>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({
            url: new URL("/page.html", url).toString(),
            format: "markdown",
            offset: 3,
            limit: 1,
          })
          expect(result.output).toBe("Two\n\n(Showing lines 3-3 of 5. Use offset=4 to continue.)")
        }),
    ),
  )

  it.instance("windows raw html when format is html", () =>
    withFetch(
      () =>
        new Response("<div>one</div>\n<div>two</div>\n<div>three</div>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({
            url: new URL("/page.html", url).toString(),
            format: "html",
            offset: 2,
            limit: 1,
          })
          expect(result.output).toContain("<div>two</div>")
          expect(result.output).not.toContain("<div>one</div>")
          expect(result.output).not.toContain("<div>three</div>")
          expect(result.output).toContain("(Showing lines 2-2 of 3. Use offset=3 to continue.)")
        }),
    ),
  )

  it.instance("adds a continuation notice to large default output", () =>
    withFetch(
      () =>
        new Response(Array.from({ length: 2001 }, (_, i) => `line${i + 1}`).join("\n"), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toContain("(Showing lines 1-2000 of 2001. Use offset=2001 to continue.)")
          expect(result.output).not.toContain("line2001")
          expect(result.metadata.truncated).toBe(true)
        }),
    ),
  )

  capped.instance("re-truncates a fitting window through a tighter configured output cap", () =>
    withFetch(
      () =>
        // 100 lines of ~380 bytes: the window holds the whole body, so it fits
        // webfetch's own 50 KB cap, but still exceeds the configured 10 KB
        // `tool_output.max_bytes`.
        new Response(Array.from({ length: 100 }, (_, i) => `line${i} ${"x".repeat(380)}`).join("\n"), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", limit: 100 })
          // The generic wrapper capped the window at the configured 10 KB, so its
          // byte-truncation hint is present and no webfetch window notice is.
          expect(result.output).toContain("bytes truncated...")
          expect(result.output).not.toContain("(Showing lines")
          expect(result.metadata.truncated).toBe(true)
          expect(result.metadata.outputPath).toBeDefined()
        }),
    ),
  )

  it.instance("caps a window by bytes when lines are long", () =>
    withFetch(
      () =>
        new Response(Array.from({ length: 30 }, (_, i) => `${i}:${"x".repeat(2500)}`).join("\n"), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 1 })
          expect(result.output).toContain("(line truncated to 2000 chars)")
          expect(result.output).toContain("(Output capped at 50 KB. Showing lines 1-")
          expect(result.output).toContain("Use offset=")
          expect(result.metadata.truncated).toBe(true)
        }),
    ),
  )

  it.instance("resumes after a byte cap over mixed long and short lines", () =>
    withFetch(
      () =>
        new Response(
          [`small:${"s".repeat(100)}`, ...Array.from({ length: 40 }, (_, i) => `long${i}:${"x".repeat(2500)}`)].join(
            "\n",
          ),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
      (server) =>
        Effect.gen(function* () {
          const url = new URL("/mixed.txt", server).toString()
          const first = yield* exec({ url, format: "text", offset: 1 })
          expect(first.output).toContain("small:")
          expect(first.output).toContain("(line truncated to 2000 chars)")
          expect(first.output).toContain("(Output capped at 50 KB. Showing lines 1-")

          const next = Number(first.output.match(/Use offset=(\d+) to continue\./)![1])
          expect(next).toBeGreaterThan(1)

          const second = yield* exec({ url, format: "text", offset: next })
          // Line 1 is the short line, so line `next` is `long${next - 2}`.
          expect(second.output.startsWith(`long${next - 2}:`)).toBe(true)
          expect(second.output).not.toContain("small:")
          expect(second.output).toContain("(End of file - total 41 lines)")
        }),
    ),
  )

  it.instance("fails when offset starts past the end of the content", () =>
    withFetch(
      () => new Response("alpha\nbeta", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 10 }).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            // A normal tool failure, not a defect escaping Effect.orDie.
            expect(Cause.hasFails(exit.cause)).toBe(true)
            expect(Cause.hasDies(exit.cause)).toBe(false)
            expect(String(Cause.squash(exit.cause))).toContain("Offset 10 is out of range")
          }
        }),
    ),
  )
})
