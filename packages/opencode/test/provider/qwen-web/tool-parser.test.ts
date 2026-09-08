import { describe, expect, test } from "bun:test"
import { parseCompleteResponse, repairJsonPayload, StreamingToolParser } from "@/provider/qwen-web/tool-parser"

describe("repairJsonPayload", () => {
  test("parses clean JSON", () => {
    expect(repairJsonPayload('{"a":1}')).toEqual({ a: 1 })
    expect(repairJsonPayload("  ")).toBeUndefined()
  })

  test("strips markdown fences", () => {
    expect(repairJsonPayload('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(repairJsonPayload('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test("removes trailing commas", () => {
    expect(repairJsonPayload('{"a":1,}')).toEqual({ a: 1 })
    expect(repairJsonPayload('{"a":[1,2,]}')).toEqual({ a: [1, 2] })
  })

  test("extracts a balanced object from surrounding prose", () => {
    expect(repairJsonPayload('Sure! {"a":1} here you go')).toEqual({ a: 1 })
  })

  test("completes truncated payloads", () => {
    expect(repairJsonPayload('{"a": "b')).toEqual({ a: "b" })
    expect(repairJsonPayload('{"a": {"b": 1')).toEqual({ a: { b: 1 } })
  })

  test("gives up on non-JSON", () => {
    expect(repairJsonPayload("just words")).toBeUndefined()
  })
})

describe("StreamingToolParser", () => {
  test("passes plain text through", () => {
    const parser = new StreamingToolParser()
    expect(parser.push("Hello, world!")).toEqual({ text: "Hello, world!", toolCalls: [] })
    expect(parser.flush()).toEqual({ text: "", toolCalls: [] })
  })

  test("extracts a canonical block", () => {
    const parser = new StreamingToolParser({ declared: new Set(["read_file"]) })
    const result = parser.push(
      'Let me read that.\n<qw_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n</qw_call>',
    )
    expect(result.text).toBe("Let me read that.\n")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe("read_file")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ path: "a.txt" })
    expect(result.toolCalls[0]?.id).toMatch(/^call_/)
  })

  test("accepts legacy tag spellings", () => {
    const result = parseCompleteResponse('<tool_call>{"name":"a","arguments":{}}</tool_call>')
    expect(result.toolCalls.map((call) => call.name)).toEqual(["a"])
    const plural = parseCompleteResponse('<tool_calls>[{"name":"b"}]</tool_calls>')
    // Arrays are not valid single-call payloads; preserved as text instead.
    expect(plural.toolCalls).toEqual([])
    expect(plural.text).toContain("b")
  })

  test("accepts the function wrapper shape", () => {
    const result = parseCompleteResponse('<qw_call>{"function": {"name": "f", "arguments": "{\\"x\\": 1}"}}</qw_call>')
    expect(result.toolCalls[0]?.name).toBe("f")
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ x: 1 })
  })

  test("handles tags split across chunks", () => {
    const parser = new StreamingToolParser()
    expect(parser.push("Text <qw_").text).toBe("Text ")
    expect(parser.push('call>\n{"name": "t", "argum').toolCalls).toEqual([])
    const last = parser.push('ents": {}}\n</qw_call>\nDone')
    expect(last.toolCalls.map((call) => call.name)).toEqual(["t"])
    expect(last.text).toBe("\nDone")
  })

  test("recovers an unclosed block on flush", () => {
    const parser = new StreamingToolParser()
    const first = parser.push('Working <qw_call>\n{"name": "t", "arguments": {"a": 1}}')
    expect(first.text).toBe("Working ")
    const flushed = parser.flush()
    expect(flushed.text).toBe("")
    expect(flushed.toolCalls.map((call) => call.name)).toEqual(["t"])
  })

  test("preserves unparseable blocks as text", () => {
    const result = parseCompleteResponse("Before <qw_call>not json at all</qw_call> after")
    expect(result.toolCalls).toEqual([])
    expect(result.text).toContain("not json at all")
    expect(result.text).toContain("Before")
  })

  test("enforces the per-turn cap", () => {
    const parser = new StreamingToolParser({ maxToolCalls: 2 })
    parser.push('<qw_call>{"name":"a"}</qw_call><qw_call>{"name":"b"}</qw_call>')
    const extra = parser.push('<qw_call>{"name":"c"}</qw_call>')
    expect(extra.toolCalls).toEqual([])
    expect(parser.isCapped).toBe(true)
    expect(parser.toolCallCount).toBe(3)
  })

  test("accepts unknown tool names (AI SDK repairs them)", () => {
    const result = parseCompleteResponse('<qw_call>{"name":"invented","arguments":{}}</qw_call>', {
      declared: new Set(["real"]),
    })
    expect(result.toolCalls.map((call) => call.name)).toEqual(["invented"])
  })

  test("uses the open-tag name attribute as a fallback", () => {
    const result = parseCompleteResponse('<qw_call name="attr_tool">{"arguments": {"x": true}}</qw_call>')
    expect(result.toolCalls[0]?.name).toBe("attr_tool")
  })
})
