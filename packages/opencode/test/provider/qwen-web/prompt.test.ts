import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { buildToolInstructions, buildToolManifest, functionTools, renderPrompt } from "@/provider/qwen-web/prompt"
import type { QwenWebToolDefinition } from "@/provider/qwen-web/prompt"

describe("renderPrompt", () => {
  test("renders system, user, assistant and tool turns", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read it." },
          { type: "reasoning", text: "Need the file contents." },
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: '{"path":"a.txt"}' },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "hello" } },
        ],
      },
    ]
    const rendered = renderPrompt(prompt)
    expect(rendered.media).toEqual([])
    expect(rendered.text).toContain("Be helpful.")
    expect(rendered.text).toContain("User: Read a.txt")
    expect(rendered.text).toContain("Assistant: I will read it.")
    expect(rendered.text).toContain("Need the file contents.")
    expect(rendered.text).toContain("<qw_call>")
    expect(rendered.text).toContain('"name":"read_file"')
    expect(rendered.text).toContain("Tool Response (read_file): hello")
    // System block leads, transcript follows.
    expect(rendered.text.indexOf("Be helpful.")).toBeLessThan(rendered.text.indexOf("User:"))
  })

  test("resolves tool names from history when the result omits them", () => {
    // Deliberately untyped: the tool-result omits `toolName`, which the
    // v3 types require but the renderer tolerates via history lookup.
    const prompt = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c9", toolName: "run", input: "{}" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c9", output: { type: "text", value: "ok" } }],
      },
    ]
    expect(renderPrompt(prompt as LanguageModelV3Prompt).text).toContain("Tool Response (run): ok")
  })

  test("collects file parts as media", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "file", data: "aGVsbG8=", mediaType: "image/png", filename: "hi.png" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
          { type: "file", data: "https://example.com/x.png", mediaType: "image/png" },
        ],
      },
    ]
    const rendered = renderPrompt(prompt)
    expect(rendered.media).toHaveLength(3)
    expect(rendered.media[0]?.source).toBe("data:image/png;base64,aGVsbG8=")
    expect(rendered.media[0]?.filename).toBe("hi.png")
    expect(rendered.media[1]?.source).toBe("data:image/jpeg;base64,AQID")
    expect(rendered.media[2]?.source).toBe("https://example.com/x.png")
    expect(rendered.text).toContain("User: What is this?")
  })

  test("renders string assistant content and json tool output", () => {
    // Deliberately untyped: the v3 types require array assistant content,
    // but the renderer also tolerates plain strings.
    const prompt = [
      { role: "assistant", content: "done" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "t",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]
    const text = renderPrompt(prompt as LanguageModelV3Prompt).text
    expect(text).toContain("Assistant: done")
    expect(text).toContain('Tool Response (t): {"ok":true}')
  })

  test("renders denied execution and content outputs", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "execution-denied", reason: "no" } },
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "t",
            output: {
              type: "content",
              value: [
                { type: "text", text: "part" },
                { type: "image-url", url: "https://x/y.png" },
              ],
            },
          },
        ],
      },
    ]
    const text = renderPrompt(prompt).text
    expect(text).toContain("Execution denied: no")
    expect(text).toContain("[media: https://x/y.png]")
  })
})

describe("tool manifest and instructions", () => {
  const tools: QwenWebToolDefinition[] = [
    {
      type: "function" as const,
      name: "read_file",
      description: "Read a file from disk.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
    },
    { type: "provider" as const, name: "web_search", id: "qwen-web.web_search", args: {} },
  ]

  test("manifest uses signature style and skips provider tools", () => {
    expect(buildToolManifest(tools)).toBe("read_file(path: string, limit?: number) - Read a file from disk.")
  })

  test("functionTools filters to function tools", () => {
    expect(functionTools(tools).map((tool) => tool.name)).toEqual(["read_file"])
    expect(functionTools(undefined)).toEqual([])
  })

  test("instructions embed the contract and forced choices", () => {
    const instructions = buildToolInstructions(tools)
    expect(instructions).toContain("# TOOLS AVAILABLE")
    expect(instructions).toContain("read_file(path: string, limit?: number)")
    expect(instructions).toContain("<qw_call>")
    expect(instructions).not.toContain("CRITICAL: You MUST call")
    const forced = buildToolInstructions(tools, { type: "tool", toolName: "read_file" })
    expect(forced).toContain('MUST call the tool "read_file"')
    const required = buildToolInstructions(tools, { type: "required" })
    expect(required).toContain("MUST call at least one tool")
  })
})
