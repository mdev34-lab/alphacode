import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { describe, it, expect } from "bun:test"

describe("PromptInput.FileAttachment", () => {
  it("round-trips uri/name and leaves id optional", () => {
    const attachment = PromptInput.FileAttachment.create({
      uri: "data:image/png;base64,AAA",
      name: "shot.png",
    })
    expect(attachment.id).toBeUndefined()
    expect(attachment.uri).toBe("data:image/png;base64,AAA")
    expect(attachment.name).toBe("shot.png")
  })

  it("accepts a client-supplied id", () => {
    const attachment = PromptInput.FileAttachment.create({
      id: "att_1",
      uri: "data:image/png;base64,AAA",
      name: "shot.png",
    })
    expect(attachment.id).toBe("att_1")
  })
})
