/**
 * Adapter for the OpenCode Zen gateway (`https://opencode.ai/zen/v1`).
 *
 * Zen only serves its free tier (`deepseek-v4-flash-free`, `big-pickle`,
 * `mimo-v2.5-free`, ...) to clients that identify themselves as the OpenCode
 * CLI, so requests from a plain HTTP client are rejected before the model runs:
 *
 * - a missing `x-opencode-session` is rejected with `400 MissingSessionID`,
 * - standard library/OpenAI SDK user agents are rejected with
 *   `403 FreeTierError`,
 * - free models only accept `Authorization: Bearer public`; a regular `sk-*`
 *   key without a billing account attached is rejected,
 * - non-streaming calls (`{"stream": false}`) are rejected,
 * - payloads without any tool definition are rejected.
 *
 * `createFetch` is installed as the provider fetch for the `opencode` provider,
 * so it observes the exact request the AI SDK would send and can satisfy that
 * contract: client/session/request headers are added, free models are
 * authenticated with the public bearer token, `stream: true` is enforced with
 * the SSE response re-assembled into the JSON completion the caller expected,
 * and an empty tool list gets a placeholder definition.
 */

import { isRecord } from "@/util/record"

/** User agent the gateway accepts. Anything else is treated as an untrusted client. */
export const ZEN_USER_AGENT = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"

/** The free tier authenticates as the public client; paid keys require a billing account. */
export const ZEN_PUBLIC_AUTHENTICATION = "Bearer public"

const ZEN_PLACEHOLDER_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description: "Do not call this tool. It exists only to satisfy the gateway tool schema.",
    parameters: { type: "object", properties: {} },
  },
}

/** Session ids stay stable for one conversation thread; request ids change every turn. */
export function sessionID(value: string | undefined) {
  if (value === undefined || value.length === 0) return `ses_${crypto.randomUUID()}`
  return value.startsWith("ses_") ? value : `ses_${value}`
}

/** Request ids are regenerated for every provider turn. */
export function requestID() {
  return `msg_${crypto.randomUUID()}`
}

type Chunk = {
  id?: string
  created?: number
  model?: string
  usage?: unknown
  choices?: ReadonlyArray<{
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: ReadonlyArray<{
        id?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }>
    }
    finish_reason?: string | null
  }>
}

function parseChunks(lines: readonly string[]) {
  return lines.flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return []
    const data = trimmed.slice("data:".length).trim()
    if (data.length === 0 || data === "[DONE]") return []
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    return isRecord(parsed) ? [parsed as Chunk] : []
  })
}

/** Re-assemble a streamed completion into the JSON response a non-streaming caller expects. */
async function aggregate(response: Response) {
  const state = {
    id: undefined as string | undefined,
    created: undefined as number | undefined,
    model: undefined as string | undefined,
    finish: undefined as string | undefined,
    usage: undefined as unknown,
    content: "",
    reasoning: "",
    reasoningContent: "",
    calls: new Map<number, { id: string | undefined; name: string; arguments: string }>(),
  }

  for (const chunk of parseChunks((await response.text()).split("\n"))) {
    if (chunk.id !== undefined) state.id = chunk.id
    if (chunk.created !== undefined) state.created = chunk.created
    if (chunk.model !== undefined) state.model = chunk.model
    if (chunk.usage !== undefined) state.usage = chunk.usage

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) state.content += delta.content
    if (delta?.reasoning) state.reasoning += delta.reasoning
    if (delta?.reasoning_content) state.reasoningContent += delta.reasoning_content
    delta?.tool_calls?.forEach((call, index) => {
      const current = state.calls.get(index) ?? { id: undefined, name: "", arguments: "" }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.arguments += call.function.arguments
      state.calls.set(index, current)
    })
    if (choice?.finish_reason) state.finish = choice.finish_reason
  }

  const message: Record<string, unknown> = { role: "assistant", content: state.content }
  if (state.reasoningContent) message["reasoning_content"] = state.reasoningContent
  if (state.reasoning) message["reasoning"] = state.reasoning
  if (state.calls.size > 0) {
    message["tool_calls"] = [...state.calls.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([index, call]) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }))
  }

  return new Response(
    JSON.stringify({
      id: state.id,
      created: state.created,
      model: state.model,
      choices: [{ index: 0, message, finish_reason: state.finish ?? "stop" }],
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    }),
    { status: response.status, headers: { "content-type": "application/json" } },
  )
}

/** Chat completion payloads are the only Zen requests the adapter rewrites. */
function chatRequest(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["messages"])) return undefined
  return parsed
}

async function bodyOf(input: RequestInfo | URL, init: RequestInit | undefined) {
  if (typeof init?.body === "string") return init.body
  if (input instanceof Request) return input.clone().text()
  return undefined
}

/** Transport seam so callers that already wrap fetch (and tests) can reuse the adapter. */
export type ZenFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export type FetchInput = {
  /** Model ids Zen serves for free; these must authenticate as the public client. */
  readonly free?: ReadonlySet<string>
  readonly upstream?: ZenFetch
}

/**
 * Wrap a fetch so every chat completion routed to the Zen gateway carries the
 * client contract Zen verifies before running a request.
 */
export function createFetch(input: FetchInput = {}): ZenFetch {
  const upstream = input.upstream ?? globalThis.fetch
  // Callers that do not carry session context (direct SDK calls) still need a
  // session id, so the adapter keeps one thread per client instance.
  const fallback = { session: undefined as string | undefined }

  return async (requestInput, init) => {
    const url = requestInput instanceof Request ? requestInput.url : String(requestInput)
    const method = init?.method ?? (requestInput instanceof Request ? requestInput.method : "POST")
    const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set("user-agent", ZEN_USER_AGENT)
    headers.set("x-opencode-client", headers.get("x-opencode-client") ?? "cli")
    headers.set("x-opencode-project", headers.get("x-opencode-project") ?? "global")
    headers.set(
      "x-opencode-session",
      sessionID(headers.get("x-opencode-session") ?? (fallback.session ??= sessionID(undefined))),
    )
    headers.set("x-opencode-request", headers.get("x-opencode-request") ?? requestID())

    const body = await bodyOf(requestInput, init)
    const payload = chatRequest(body)
    if (!payload) return upstream(url, { ...init, method, headers, body: body ?? init?.body })

    if (typeof payload["model"] === "string" && input.free?.has(payload["model"])) {
      headers.set("authorization", ZEN_PUBLIC_AUTHENTICATION)
    }
    // Zen only answers streamed requests; non-streaming callers get the
    // aggregated stream back below.
    const streaming = payload["stream"] === true
    payload["stream"] = true
    if (!Array.isArray(payload["tools"]) || payload["tools"].length === 0) {
      payload["tools"] = [ZEN_PLACEHOLDER_TOOL]
      if (payload["tool_choice"] === undefined) payload["tool_choice"] = "auto"
    }

    const response = await upstream(url, { ...init, method, headers, body: JSON.stringify(payload) })
    if (!streaming && response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
      return aggregate(response)
    }
    return response
  }
}

export * as OpenCodeZen from "./opencode-zen"
