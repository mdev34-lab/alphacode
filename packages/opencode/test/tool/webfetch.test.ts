import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

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

  it.instance("fails when offset starts past the end of the content", () =>
    withFetch(
      () => new Response("alpha\nbeta", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text", offset: 10 }).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("Offset 10 is out of range")
        }),
    ),
  )
})
