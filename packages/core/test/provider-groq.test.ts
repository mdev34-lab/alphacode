import { createGroq } from "@ai-sdk/groq"
import { expect, test } from "bun:test"

test("Groq rejects unknown reasoning effort", async () => {
  let body: Record<string, unknown> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-1",
        created: 0,
        model: "openai/gpt-oss-120b",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createGroq({ apiKey: "test", fetch: mockFetch })("openai/gpt-oss-120b")

  let thrown: unknown
  await model
    .doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { groq: { reasoningEffort: "custom" } },
    })
    .catch((error) => {
      thrown = error
    })

  // @ai-sdk/groq validates reasoningEffort and rejects unknown values before
  // any request is sent.
  expect(thrown).toBeDefined()
  expect(String(thrown)).toContain("InvalidArgument")
  expect(body).toBeUndefined()
})
