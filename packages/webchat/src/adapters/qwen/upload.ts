/**
 * Multimodal uploads for the Qwen Web provider.
 *
 * Images (and other attachments) are uploaded before the completion request:
 * 1. `POST /api/v2/files/getstsToken` mints short-lived Alibaba OSS
 *    credentials for the file (via the authenticated browser context).
 * 2. The bytes are PUT to OSS directly (plain HTTPS, signed by the OSS SDK).
 * 3. The resulting file reference is attached to the completion payload.
 *
 * Uploads run fully in memory; no temporary files are written.
 */
/// <reference path="./ali-oss.d.ts" />
import { Readable } from "stream"
import { QWEN_WEB_DEFAULTS, QWEN_WEB_PATHS } from "./constants"
import { QwenWebError, classifyJsonError, classifyStatus, sessionExpiredError } from "./errors"
import { debug } from "./log"
import { buildStsBody, randomId, type QwenWebFileEntry } from "./protocol"
import type { QwenWebMedia } from "./media"
import { QwenWebTransport, sharedTransport } from "./transport"

export interface StsCredentials {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  fileUrl: string
  filePath: string
  fileId: string
  bucket: string
  region: string
  endpoint: string
}

interface FileTypeInfo {
  mime: string
  showType: "image" | "video" | "audio" | "file"
  fileClass: "vision" | "video" | "audio" | "file"
  qwenFileType: "image" | "video" | "audio" | "file"
}

const DEFAULT_TYPE: FileTypeInfo = {
  mime: "application/octet-stream",
  showType: "file",
  fileClass: "file",
  qwenFileType: "file",
}

const EXTENSION_TYPES: Record<string, FileTypeInfo> = {
  png: { mime: "image/png", showType: "image", fileClass: "vision", qwenFileType: "image" },
  jpg: { mime: "image/jpeg", showType: "image", fileClass: "vision", qwenFileType: "image" },
  jpeg: { mime: "image/jpeg", showType: "image", fileClass: "vision", qwenFileType: "image" },
  gif: { mime: "image/gif", showType: "image", fileClass: "vision", qwenFileType: "image" },
  webp: { mime: "image/webp", showType: "image", fileClass: "vision", qwenFileType: "image" },
  bmp: { mime: "image/bmp", showType: "image", fileClass: "vision", qwenFileType: "image" },
  avif: { mime: "image/avif", showType: "image", fileClass: "vision", qwenFileType: "image" },
  mp4: { mime: "video/mp4", showType: "video", fileClass: "video", qwenFileType: "video" },
  webm: { mime: "video/webm", showType: "video", fileClass: "video", qwenFileType: "video" },
  mov: { mime: "video/quicktime", showType: "video", fileClass: "video", qwenFileType: "video" },
  mp3: { mime: "audio/mpeg", showType: "audio", fileClass: "audio", qwenFileType: "audio" },
  wav: { mime: "audio/wav", showType: "audio", fileClass: "audio", qwenFileType: "audio" },
  ogg: { mime: "audio/ogg", showType: "audio", fileClass: "audio", qwenFileType: "audio" },
  m4a: { mime: "audio/mp4", showType: "audio", fileClass: "audio", qwenFileType: "audio" },
  pdf: { mime: "application/pdf", showType: "file", fileClass: "file", qwenFileType: "file" },
  txt: { mime: "text/plain", showType: "file", fileClass: "file", qwenFileType: "file" },
  md: { mime: "text/markdown", showType: "file", fileClass: "file", qwenFileType: "file" },
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
}

export function detectFileType(filename: string): FileTypeInfo {
  const extension = filename.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_TYPES[extension] ?? DEFAULT_TYPE
}

export interface QwenWebUploadOptions {
  transport?: QwenWebTransport
  maxBytes?: number
  /** Test seam: replace the OSS put. */
  putObject?: (credentials: StsCredentials, buffer: Buffer, contentType: string) => Promise<void>
}

export class QwenWebUpload {
  private readonly transport: QwenWebTransport
  private readonly maxBytes: number
  private readonly putObject: QwenWebUploadOptions["putObject"]

  constructor(options?: QwenWebUploadOptions) {
    this.transport = options?.transport ?? sharedTransport()
    this.maxBytes = options?.maxBytes ?? QWEN_WEB_DEFAULTS.maxUploadBytes
    this.putObject = options?.putObject
  }

  /** Upload every media item and return the file entries for the payload. */
  async uploadAll(media: QwenWebMedia[], signal?: AbortSignal): Promise<QwenWebFileEntry[]> {
    const entries: QwenWebFileEntry[] = []
    for (const item of media) {
      entries.push(await this.uploadOne(item, signal))
    }
    return entries
  }

  private async uploadOne(item: QwenWebMedia, signal?: AbortSignal): Promise<QwenWebFileEntry> {
    if (signal?.aborted) throw aborted()
    const { buffer, filename } = await this.resolveBytes(item, signal)
    if (buffer.byteLength === 0) {
      throw new QwenWebError({
        code: "unsupported",
        retryable: false,
        message: `Cannot upload empty file "${filename}".`,
      })
    }
    if (buffer.byteLength > this.maxBytes) {
      throw new QwenWebError({
        code: "unsupported",
        retryable: false,
        message: `File "${filename}" is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB; the Qwen Web upload limit is ${(this.maxBytes / 1024 / 1024).toFixed(0)}MB.`,
      })
    }
    const type = detectFileType(filename)
    const credentials = await this.fetchStsToken(filename, buffer.byteLength, type, signal)
    if (signal?.aborted) throw aborted()
    if (this.putObject) {
      await this.putObject(credentials, buffer, type.mime)
    } else {
      await putToOss(credentials, buffer, type.mime)
    }
    debug("upload", "file uploaded", { filename, bytes: buffer.byteLength, mime: type.mime })
    return buildFileEntry({
      filename,
      bytes: buffer.byteLength,
      type,
      fileId: credentials.fileId,
      url: credentials.fileUrl.split("?")[0]!,
    })
  }

  private async resolveBytes(item: QwenWebMedia, signal?: AbortSignal): Promise<{ buffer: Buffer; filename: string }> {
    const source = item.source
    if (source.startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source)
      if (!match)
        throw new QwenWebError({ code: "unsupported", retryable: false, message: "Malformed data URL in image input." })
      const mime = match[1] || item.mediaType || "image/png"
      const extension = MIME_EXTENSIONS[mime.toLowerCase()] ?? extensionForMime(mime)
      const buffer = Buffer.from(match[3]!, match[2] ? "base64" : "utf8")
      return { buffer, filename: item.filename || `file_${Date.now()}.${extension}` }
    }
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await fetch(source, { signal }).catch((error) => {
        throw new QwenWebError({
          code: "network_error",
          retryable: true,
          cause: error,
          message: `Failed to download media from URL: ${(error as Error)?.message ?? error}`,
        })
      })
      if (!response.ok) {
        throw new QwenWebError({
          code: "network_error",
          retryable: true,
          message: `Failed to download media (HTTP ${response.status}).`,
        })
      }
      const arrayBuffer = await response.arrayBuffer()
      const filename = item.filename || filenameFromUrl(source, response.headers.get("content-type") || item.mediaType)
      return { buffer: Buffer.from(arrayBuffer), filename }
    }
    // Bare base64.
    const mime = item.mediaType || "image/png"
    const extension = MIME_EXTENSIONS[mime.toLowerCase()] ?? extensionForMime(mime)
    return { buffer: Buffer.from(source, "base64"), filename: item.filename || `file_${Date.now()}.${extension}` }
  }

  private async fetchStsToken(
    filename: string,
    filesize: number,
    type: FileTypeInfo,
    signal?: AbortSignal,
  ): Promise<StsCredentials> {
    const response = await this.transport.requestJson("POST", QWEN_WEB_PATHS.stsToken, {
      body: JSON.stringify(buildStsBody(filename, filesize, type.qwenFileType)),
      signal,
    })
    if (response.status === 401 || response.status === 403) throw sessionExpiredError()
    let payload: any
    try {
      payload = JSON.parse(response.body)
    } catch {
      payload = undefined
    }
    const ok = response.status >= 200 && response.status < 300
    if (!ok || !payload?.success || !payload?.data) {
      throw (
        classifyJsonError(response.body, response.status) ??
        classifyStatus(response.status) ??
        new QwenWebError({
          code: "upstream_error",
          retryable: false,
          status: response.status,
          message: "Qwen refused the file upload request.",
        })
      )
    }
    const data = payload.data as Record<string, unknown>
    const required = [
      "access_key_id",
      "access_key_secret",
      "security_token",
      "file_url",
      "file_path",
      "file_id",
      "bucketname",
      "region",
      "endpoint",
    ]
    for (const key of required) {
      if (typeof data[key] !== "string" || !data[key]) {
        throw new QwenWebError({
          code: "invalid_response",
          retryable: false,
          message: "Qwen returned incomplete upload credentials.",
        })
      }
    }
    return {
      accessKeyId: data["access_key_id"] as string,
      accessKeySecret: data["access_key_secret"] as string,
      securityToken: data["security_token"] as string,
      fileUrl: data["file_url"] as string,
      filePath: data["file_path"] as string,
      fileId: data["file_id"] as string,
      bucket: data["bucketname"] as string,
      region: data["region"] as string,
      endpoint: data["endpoint"] as string,
    }
  }
}

function extensionForMime(mime: string): string {
  if (mime.startsWith("video/")) return "mp4"
  if (mime.startsWith("audio/")) return "mp3"
  if (mime.startsWith("image/")) return "png"
  return "bin"
}

function filenameFromUrl(url: string, contentType: string | null | undefined): string {
  try {
    const pathname = new URL(url).pathname
    const last = pathname.split("/").filter(Boolean).pop()
    if (last && last.includes(".")) return decodeURIComponent(last).slice(0, 128)
  } catch {
    // Fall through to a generated name.
  }
  const extension = (contentType && MIME_EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()]) || "png"
  return `file_${Date.now()}.${extension}`
}

export function buildFileEntry(input: {
  filename: string
  bytes: number
  type: FileTypeInfo
  fileId: string
  url: string
}): QwenWebFileEntry {
  const now = Date.now()
  return {
    type: input.type.showType,
    file: {
      created_at: now,
      data: {},
      filename: input.filename,
      hash: null,
      id: input.fileId,
      user_id: "alphacode-user",
      meta: { name: input.filename, size: input.bytes, content_type: input.type.mime },
      update_at: now,
      lastModified: now,
      name: input.filename,
      webkitRelativePath: "",
      size: input.bytes,
      type: input.type.mime,
    },
    id: input.fileId,
    url: input.url,
    name: input.filename,
    collection_name: "",
    progress: 100,
    status: "uploaded",
    greenNet: "success",
    size: input.bytes,
    error: "",
    itemId: randomId(),
    file_type: input.type.mime,
    showType: input.type.showType,
    file_class: input.type.fileClass,
    uploadTaskId: randomId(),
  }
}

let ossModule: any

async function putToOss(credentials: StsCredentials, buffer: Buffer, contentType: string): Promise<void> {
  if (!ossModule) {
    try {
      const loaded = (await import("ali-oss")) as { default?: unknown }
      const ctor = loaded.default ?? loaded
      if (typeof ctor !== "function") throw new Error("ali-oss did not export a constructor")
      ossModule = ctor
    } catch (error) {
      throw new QwenWebError({
        code: "unsupported",
        retryable: false,
        cause: error,
        message: "Image upload needs the `ali-oss` package. Reinstall AlphaCode dependencies and try again.",
      })
    }
  }
  const client = new ossModule({
    region: credentials.region,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken,
    bucket: credentials.bucket,
    endpoint: `https://${credentials.endpoint}`,
    secure: true,
  })
  const headers = { "Content-Type": contentType }
  const multipartThreshold = 8 * 1024 * 1024
  try {
    if (buffer.byteLength >= multipartThreshold) {
      await client.multipartUpload(credentials.filePath, buffer, { partSize: 4 * 1024 * 1024, headers })
    } else {
      await client.putStream(credentials.filePath, Readable.from(buffer), { contentLength: buffer.byteLength, headers })
    }
  } catch (error) {
    throw new QwenWebError({
      code: "network_error",
      retryable: true,
      cause: error,
      message: `File upload to storage failed: ${(error as Error)?.message ?? error}`.slice(0, 300),
    })
  }
}

function aborted(): QwenWebError {
  const error = new QwenWebError({ code: "aborted", message: "Qwen Web upload was aborted", retryable: false })
  error.name = "AbortError"
  return error
}
