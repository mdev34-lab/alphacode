import { FileAttachment } from "@opencode-ai/schema/prompt"
import { describe, it, expect } from "bun:test"

describe("FileAttachment", () => {
  it("accepts optional path and size", () => {
    const attachment = FileAttachment.create({
      id: "att_1",
      uri: "file:///x/y.png",
      mime: "image/png",
      path: "/managed/attachments/sess/att_1.png",
      size: 1234,
    })
    expect(attachment.path).toBe("/managed/attachments/sess/att_1.png")
    expect(attachment.size).toBe(1234)
  })

  it("round-trips without path/size", () => {
    const a = FileAttachment.create({ id: "att_2", uri: "data:image/png;base64,AAA", mime: "image/png" })
    expect(a.path).toBeUndefined()
    expect(a.size).toBeUndefined()
  })
})
