import { Schema } from "effect"

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
  method: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
    return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
  }
}
