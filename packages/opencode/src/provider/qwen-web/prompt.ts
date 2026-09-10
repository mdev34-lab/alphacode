/**
 * Prompt rendering for the Qwen Web provider.
 *
 * The completions endpoint accepts a single user `content` string (plus file
 * attachments), so the AI SDK message list is rendered into one transcript:
 *
 * - system messages become a leading instructions block,
 * - user / assistant turns become `User:` / `Assistant:` segments,
 * - assistant tool calls are re-wrapped in the canonical tool tags so the
 *   model sees the same contract in history that it must emit,
 * - tool results become `Tool Response (<name>):` segments.
 *
 * AlphaCode stays the authoritative conversation history: every generation
 * sends the full transcript on a fresh Qwen chat, so no server-side thread
 * state can go stale or corrupt concurrent generations.
 */
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ProviderTool,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"
import type { QwenWebMedia } from "@opencode-ai/webchat/adapters/qwen/media"
import { QWEN_WEB_TOOL_CLOSE, QWEN_WEB_TOOL_OPEN } from "@opencode-ai/webchat/adapters/qwen/constants"

export type { QwenWebMedia }

export interface RenderedPrompt {
  text: string
  media: QwenWebMedia[]
}

export function renderPrompt(prompt: LanguageModelV3Prompt): RenderedPrompt {
  const systemParts: string[] = []
  const segments: string[] = []
  const media: QwenWebMedia[] = []
  const toolNames = new Map<string, string>()

  for (const message of prompt) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call") toolNames.set(part.toolCallId, part.toolName)
      }
    }
  }

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        if (message.content.trim()) systemParts.push(message.content.trim())
        break
      }
      case "user": {
        const textParts: string[] = []
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text) textParts.push(part.text)
          } else if (part.type === "file") {
            const source = dataContentToSource(part.data, part.mediaType)
            if (source) media.push({ source, mediaType: part.mediaType, filename: part.filename })
          }
        }
        const text = textParts.join("\n")
        segments.push(`User: ${text}\n`)
        break
      }
      case "assistant": {
        const chunks: string[] = []
        if (typeof message.content === "string") {
          if (message.content) chunks.push(message.content)
        } else {
          for (const part of message.content) {
            if (part.type === "text") {
              if (part.text) chunks.push(part.text)
            } else if (part.type === "reasoning") {
              if (part.text.trim()) chunks.push(part.text.trim())
            } else if (part.type === "tool-call") {
              chunks.push(wrapToolCall(part.toolName, part.input))
            } else if (part.type === "tool-result") {
              chunks.push(`Tool Response (${part.toolName}): ${toolOutputText(part.output)}`)
            }
          }
        }
        segments.push(`Assistant: ${chunks.join("\n").trim()}\n`)
        break
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const name = part.toolName || toolNames.get(part.toolCallId) || "tool"
          segments.push(`Tool Response (${name}): ${toolOutputText(part.output)}\n`)
        }
        break
      }
    }
  }

  const text = [...systemParts, segments.join("\n").trimEnd()].filter(Boolean).join("\n\n")
  return { text, media }
}

function dataContentToSource(data: Uint8Array | string | URL, mediaType: string): string | undefined {
  if (typeof data === "string") {
    if (data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")) return data
    return `data:${mediaType || "application/octet-stream"};base64,${data}`
  }
  if (data instanceof URL) return data.toString()
  const base64 = Buffer.from(data).toString("base64")
  return `data:${mediaType || "application/octet-stream"};base64,${base64}`
}

function toolOutputText(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value
    case "json":
    case "error-json":
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value)
    case "execution-denied":
      return output.reason ? `Execution denied: ${output.reason}` : "Execution denied."
    case "content":
      return output.value
        .map((item) => {
          if (item.type === "text") return item.text
          if (item.type === "file-data" || item.type === "image-data") {
            const filename = item.type === "file-data" ? item.filename : undefined
            return `[media: ${item.mediaType}${filename ? ` ${filename}` : ""}]`
          }
          if (item.type === "file-url" || item.type === "image-url") return `[media: ${item.url}]`
          if (item.type === "file-id" || item.type === "image-file-id") return "[media: file reference]"
          return ""
        })
        .filter(Boolean)
        .join("\n")
  }
}

function wrapToolCall(name: string, input: unknown): string {
  let args: unknown = input
  if (typeof input === "string") {
    try {
      args = JSON.parse(input)
    } catch {
      args = { _raw: input }
    }
  }
  return `${QWEN_WEB_TOOL_OPEN}\n${JSON.stringify({ name, arguments: args ?? {} })}\n${QWEN_WEB_TOOL_CLOSE}`
}

// ---------------------------------------------------------------------------
// Tool manifest & instructions
// ---------------------------------------------------------------------------

export type QwenWebToolDefinition = LanguageModelV3FunctionTool | LanguageModelV3ProviderTool

export function isFunctionTool(tool: QwenWebToolDefinition): tool is LanguageModelV3FunctionTool {
  return tool.type === "function"
}

function formatSignature(name: string, schema: unknown, required: boolean): string {
  const optional = required ? "" : "?"
  if (!schema || typeof schema !== "object") return `${name}${optional}: any`
  const record = schema as Record<string, unknown>
  if (Array.isArray(record["enum"]) && record["enum"].length > 0) {
    const values = record["enum"].map((value) => (typeof value === "string" ? `"${value}"` : String(value))).join(" | ")
    return `${name}${optional}: ${values}`
  }
  if (record["type"] === "array") {
    const items = record["items"]
    const itemType =
      items && typeof items === "object" && typeof (items as Record<string, unknown>)["type"] === "string"
        ? (items as Record<string, unknown>)["type"]
        : "any"
    return `${name}${optional}: ${itemType}[]`
  }
  return `${name}${optional}: ${(typeof record["type"] === "string" && record["type"]) || "any"}`
}

/**
 * Compact human/LLM-readable tool manifest in TypeScript-signature style.
 * Keeps parameter names, types, optionality and enums without JSON overhead.
 */
export function buildToolManifest(tools: QwenWebToolDefinition[]): string {
  const lines: string[] = []
  for (const tool of tools) {
    if (!isFunctionTool(tool)) continue
    const parameters = (tool.inputSchema ?? {}) as Record<string, unknown>
    const properties = (parameters["properties"] ?? {}) as Record<string, unknown>
    const requiredList = parameters["required"]
    const required = new Set(
      Array.isArray(requiredList) ? requiredList.filter((item): item is string => typeof item === "string") : [],
    )
    const signature = Object.entries(properties)
      .map(([param, schema]) => formatSignature(param, schema, required.has(param)))
      .join(", ")
    const description = (tool.description ?? "").replace(/\s+/g, " ").trim()
    lines.push(description ? `${tool.name}(${signature}) - ${description}` : `${tool.name}(${signature})`)
  }
  return lines.join("\n")
}

const toolInstructionsCache = new Map<string, string>()
const TOOL_INSTRUCTIONS_CACHE_MAX = 64

export function buildToolInstructions(tools: QwenWebToolDefinition[], toolChoice?: LanguageModelV3ToolChoice): string {
  const manifest = buildToolManifest(tools)
  const cacheKey = `${manifest}##${JSON.stringify(toolChoice ?? null)}`
  const cached = toolInstructionsCache.get(cacheKey)
  if (cached !== undefined) return cached

  let forced = ""
  if (toolChoice?.type === "tool") {
    forced = `\nCRITICAL: You MUST call the tool "${toolChoice.toolName}" in this response.\n`
  } else if (toolChoice?.type === "required") {
    forced = `\nCRITICAL: You MUST call at least one tool in this response.\n`
  }

  const instructions = `

# TOOLS AVAILABLE
${manifest}
${forced}
[TOOL CALL CONTRACT - MANDATORY]
To invoke a tool, output a JSON object wrapped EXACTLY in ${QWEN_WEB_TOOL_OPEN} and ${QWEN_WEB_TOOL_CLOSE} tags.
When calling multiple independent tools, output consecutive blocks:

${QWEN_WEB_TOOL_OPEN}
{"name": "read_file", "arguments": {"path": "file1.txt"}}
${QWEN_WEB_TOOL_CLOSE}
${QWEN_WEB_TOOL_OPEN}
{"name": "read_file", "arguments": {"path": "file2.txt"}}
${QWEN_WEB_TOOL_CLOSE}

CRITICAL RULES:
1. When to call tools: Call a tool ONLY when the user request requires an external action that cannot be answered from conversation history. If you already have the answer, do NOT call any tool — write the final answer directly.
2. Parallel Execution: When multiple independent operations are needed, emit multiple consecutive ${QWEN_WEB_TOOL_OPEN} blocks in parallel. Each block must be complete and self-contained (never nested or interleaved). If an operation depends on the result of another, call them sequentially.
3. Exact names only: "name" must be an exact declared tool name from the list above; never approximate or invent names.
4. Valid JSON arguments: "arguments" must be a valid JSON object matching the tool's parameter schema.
5. No raw JSON: NEVER output raw JSON without wrapping in ${QWEN_WEB_TOOL_OPEN} and ${QWEN_WEB_TOOL_CLOSE} tags.
6. Clean blocks: Put only valid JSON inside each block — no markdown fences, comments, or explanatory text.
7. Stop immediately: Stop generating immediately after the final ${QWEN_WEB_TOOL_CLOSE} tag. Do not emit trailing explanations or reasoning after the tool calls.
8. Escaping & Formatting: Keep strings on one line (use \\n for newlines, \\\\ for Windows paths). Do not split values across lines.
9. No duplicate calls: Never call the same tool with identical arguments if the result is already in the history.
`

  if (toolInstructionsCache.size >= TOOL_INSTRUCTIONS_CACHE_MAX) toolInstructionsCache.clear()
  toolInstructionsCache.set(cacheKey, instructions)
  return instructions
}

/** Provider-executed tools are never executed by AlphaCode; only `function` tools are supported. */
export function functionTools(tools: QwenWebToolDefinition[] | undefined): LanguageModelV3FunctionTool[] {
  if (!tools) return []
  return tools.filter(isFunctionTool)
}
