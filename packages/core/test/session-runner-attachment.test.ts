import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"

const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const dir = mkdtempSync(path.join(tmpdir(), "alphacode-att-"))
const textPath = path.join(dir, "note.txt")
const pngPath = path.join(dir, "img.png")
writeFileSync(textPath, "hello world")
writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

const user = (files: FileAttachment[]) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_user"),
    type: "user",
    text: "see attachments",
    files,
    time: { created: DateTime.makeUnsafe(0) },
  })

const run = (files: FileAttachment[]) =>
  Effect.runPromise(
    toLLMMessages([user(files)], model).pipe(
      Effect.provide(LayerNode.compile(FSUtil.node) as Layer.Layer<FSUtil.Service>),
    ),
  )

describe("toLLMMessages attachment lowering", () => {
  test("inlines a text attachment with a header", async () => {
    const messages = await run([
      FileAttachment.create({ id: "att_1", uri: textPath, mime: "text/plain", name: "note.txt", path: textPath, size: 11 }),
    ])
    const userMessage = messages.find((message) => message.role === "user")
    const text = userMessage?.content.find((part) => part.type === "text" && part.text.includes("hello world"))
    expect(text).toBeDefined()
    if (text && text.type === "text") {
      expect(text.text).toContain("hello world")
      expect(text.text).toContain("note.txt")
    }
  })

  test("lowers a binary attachment as base64 media", async () => {
    const messages = await run([
      FileAttachment.create({ id: "att_2", uri: pngPath, mime: "image/png", name: "img.png", path: pngPath, size: 11 }),
    ])
    const userMessage = messages.find((message) => message.role === "user")
    const media = userMessage?.content.find((part) => part.type === "media")
    expect(media).toBeDefined()
    if (media && media.type === "media") {
      expect(media.mediaType).toBe("image/png")
      expect(media.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64"))
    }
  })

  test("marks an unavailable attachment as a text note", async () => {
    const messages = await run([
      FileAttachment.create({ id: "att_3", uri: "file:///does/not/exist.txt", mime: "text/plain", name: "missing.txt" }),
    ])
    const userMessage = messages.find((message) => message.role === "user")
    const note = userMessage?.content.find((part) => part.type === "text" && part.text.includes("unavailable"))
    expect(note).toBeDefined()
  })
})
