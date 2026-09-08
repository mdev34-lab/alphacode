import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Auth, Endpoint, HttpTransport } from "../src/route"
import { Model } from "../src/schema"

const model = Model.make({ id: "model-1", provider: "test", route: OpenAIChat.route })
const encodeBody = Schema.encodeSync(Schema.fromJsonString(OpenAIChat.protocol.body.schema))

const request = (http?: { readonly body?: Record<string, unknown> }) =>
  LLM.request({
    model,
    system: "You are concise.",
    prompt: "Say hi in one word",
    tools: [],
    http,
  })

describe("HTTP transport body construction", () => {
  test("the measured body text is exactly the body the request parts send", async () => {
    const plain = request()
    const body = await Effect.runPromise(OpenAIChat.protocol.body.from(plain).pipe(Effect.orDie))

    const measured = await Effect.runPromise(HttpTransport.jsonBodyText(body, plain, encodeBody).pipe(Effect.orDie))
    const parts = await Effect.runPromise(
      HttpTransport.jsonRequestParts({
        body,
        request: plain,
        endpoint: Endpoint.path("/chat", { baseURL: "https://api.example.test/v1/" }),
        auth: Auth.none,
        encodeBody,
      }).pipe(Effect.orDie),
    )

    expect(measured).toBe(parts.bodyText)
    expect(Buffer.byteLength(measured, "utf8")).toBe(Buffer.byteLength(parts.bodyText, "utf8"))
  })

  test("an http.body overlay is part of the measured body, byte for byte", async () => {
    const plain = request({ body: { gateway_diagnostics: { trace: "abc" }, provider_tuning: "q".repeat(1_000) } })
    const body = await Effect.runPromise(OpenAIChat.protocol.body.from(plain).pipe(Effect.orDie))

    const measured = await Effect.runPromise(HttpTransport.jsonBodyText(body, plain, encodeBody).pipe(Effect.orDie))
    const parts = await Effect.runPromise(
      HttpTransport.jsonRequestParts({
        body,
        request: plain,
        endpoint: Endpoint.path("/chat", { baseURL: "https://api.example.test/v1/" }),
        auth: Auth.none,
        encodeBody,
      }).pipe(Effect.orDie),
    )
    const bare = request()
    const bareBody = await Effect.runPromise(OpenAIChat.protocol.body.from(bare).pipe(Effect.orDie))
    const bareText = await Effect.runPromise(HttpTransport.jsonBodyText(bareBody, bare, encodeBody).pipe(Effect.orDie))

    expect(measured).toBe(parts.bodyText)
    // The overlay keys are real wire bytes: the body carries them, and the size grew by them.
    expect(measured).toContain("gateway_diagnostics")
    expect(measured).toContain("provider_tuning")
    expect(Buffer.byteLength(measured, "utf8")).toBeGreaterThan(Buffer.byteLength(bareText, "utf8") + 1_000)
  })

  test("a conversation-owning overlay key is refused by measurement exactly as by transport", async () => {
    const forbidden = request({ body: { messages: [] } })
    const body = await Effect.runPromise(OpenAIChat.protocol.body.from(forbidden).pipe(Effect.orDie))

    const measured = await Effect.runPromise(HttpTransport.jsonBodyText(body, forbidden, encodeBody).pipe(Effect.exit))
    const parts = await Effect.runPromise(
      HttpTransport.jsonRequestParts({
        body,
        request: forbidden,
        endpoint: Endpoint.path("/chat", { baseURL: "https://api.example.test/v1/" }),
        auth: Auth.none,
        encodeBody,
      }).pipe(Effect.exit),
    )

    expect(measured._tag).toBe("Failure")
    expect(parts._tag).toBe("Failure")
  })
})
