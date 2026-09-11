import { describe, expect, test } from "bun:test"
import { QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import type { QwenWebTransport } from "@opencode-ai/webchat/adapters/qwen/transport"
import { buildFileEntry, detectFileType, QwenWebUpload, type StsCredentials } from "@opencode-ai/webchat/adapters/qwen/upload"

const STS_BODY = JSON.stringify({
  success: true,
  data: {
    access_key_id: "id",
    access_key_secret: "secret",
    security_token: "token",
    file_url: "https://oss.example.com/f.png?sig=1",
    file_path: "uploads/f.png",
    file_id: "file-1",
    bucketname: "bucket",
    region: "oss-cn-hangzhou",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
  },
})

function stsTransport(body: string = STS_BODY, status = 200): QwenWebTransport {
  return {
    requestJson: (async () => ({
      status,
      statusText: "OK",
      contentType: "application/json",
      body,
    })) as QwenWebTransport["requestJson"],
  } as unknown as QwenWebTransport
}

async function captureRejection(promise: Promise<unknown>): Promise<QwenWebError> {
  try {
    await promise
  } catch (error) {
    return error as QwenWebError
  }
  throw new Error("expected promise to reject")
}

describe("detectFileType", () => {
  test("maps extensions to mime and classes", () => {
    expect(detectFileType("a.png")).toMatchObject({ mime: "image/png", showType: "image", fileClass: "vision" })
    expect(detectFileType("A.JPG")).toMatchObject({ mime: "image/jpeg" })
    expect(detectFileType("song.mp3")).toMatchObject({ mime: "audio/mpeg", showType: "audio" })
    expect(detectFileType("clip.mp4")).toMatchObject({ mime: "video/mp4", showType: "video" })
    expect(detectFileType("doc.pdf")).toMatchObject({ mime: "application/pdf", showType: "file" })
    expect(detectFileType("blob.xyz")).toMatchObject({ mime: "application/octet-stream", showType: "file" })
  })
})

describe("buildFileEntry", () => {
  test("builds the payload entry with a clean url", () => {
    const entry = buildFileEntry({
      filename: "a.png",
      bytes: 10,
      type: detectFileType("a.png"),
      fileId: "file-1",
      url: "https://oss.example.com/f.png",
    })
    expect(entry.id).toBe("file-1")
    expect(entry.url).toBe("https://oss.example.com/f.png")
    expect(entry.status).toBe("uploaded")
    expect(entry.file_type).toBe("image/png")
    expect(entry.showType).toBe("image")
  })
})

describe("QwenWebUpload.uploadAll", () => {
  test("uploads a data-url image through STS", async () => {
    const puts: Array<{ credentials: StsCredentials; bytes: number; contentType: string }> = []
    const upload = new QwenWebUpload({
      transport: stsTransport(),
      putObject: async (credentials, buffer, contentType) => {
        puts.push({ credentials, bytes: buffer.byteLength, contentType })
      },
    })
    const entries = await upload.uploadAll([{ source: "data:image/png;base64,aGVsbG8=" }])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe("file-1")
    // Signed query params are stripped: the entry keeps the object URL.
    expect(entries[0]?.url).toBe("https://oss.example.com/f.png")
    expect(entries[0]?.name).toMatch(/\.png$/)
    expect(puts).toHaveLength(1)
    expect(puts[0]?.bytes).toBe(5)
    expect(puts[0]?.contentType).toBe("image/png")
    expect(puts[0]?.credentials.fileId).toBe("file-1")
  })

  test("rejects empty and oversized files", async () => {
    const upload = new QwenWebUpload({ transport: stsTransport(), putObject: async () => {}, maxBytes: 4 })
    const empty = await captureRejection(upload.uploadAll([{ source: "data:image/png;base64," }]))
    expect(empty.code).toBe("unsupported")
    const big = await captureRejection(upload.uploadAll([{ source: "data:image/png;base64,aGVsbG8=" }]))
    expect(big.code).toBe("unsupported")
    expect(big.message).toContain("limit")
  })

  test("STS failures are typed", async () => {
    const denied = new QwenWebUpload({
      transport: stsTransport('{"success":false,"message":"no"}'),
      putObject: async () => {},
    })
    const error = await captureRejection(denied.uploadAll([{ source: "data:image/png;base64,aGVsbG8=" }]))
    expect(error.code).toBe("upstream_error")

    const expired = new QwenWebUpload({ transport: stsTransport("{}", 401), putObject: async () => {} })
    const expiredError = await captureRejection(expired.uploadAll([{ source: "data:image/png;base64,aGVsbG8=" }]))
    expect(expiredError.code).toBe("session_expired")
  })

  test("downloads remote urls before uploading", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array([9, 9, 9]))) as unknown as typeof fetch
    try {
      let bytes = 0
      const upload = new QwenWebUpload({
        transport: stsTransport(),
        putObject: async (_credentials, buffer) => {
          bytes = buffer.byteLength
        },
      })
      const entries = await upload.uploadAll([{ source: "https://example.com/photo.png" }])
      expect(bytes).toBe(3)
      expect(entries[0]?.name).toBe("photo.png")
    } finally {
      globalThis.fetch = original
    }
  })

  test("aborted signals stop the upload", async () => {
    const upload = new QwenWebUpload({ transport: stsTransport(), putObject: async () => {} })
    const controller = new AbortController()
    controller.abort()
    const error = await upload
      .uploadAll([{ source: "data:image/png;base64,aGVsbG8=" }], controller.signal)
      .catch((e) => e)
    expect((error as QwenWebError).code).toBe("aborted")
  })
})
