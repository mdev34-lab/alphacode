/**
 * Server-side support for the TUI "Paste to File" feature.
 *
 * When the composer captures a large pasted text payload it sends it as a
 * `data:text/plain` file part (see packages/tui/src/prompt/paste.ts). At
 * admission, `resolvePart` in prompt.ts inlines pastes up to
 * `PASTE_INLINE_MAX_BYTES` (existing behavior) and, for larger payloads,
 * writes the full content to the managed attachment directory and inlines a
 * bounded preview instead. The full content is never lost: the file retains
 * every byte and the synthetic note tells the model where to find it.
 *
 * Files are written to the same managed directory the v2 `AttachmentStore`
 * uses for materialized conversation attachments
 * (`<data>/attachments/<sessionID>/...`).
 */
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { takePrefix, takeSuffix } from "@opencode-ai/core/tool-output-store"

export const PASTE_FILE_DIRECTORY = "attachments"

/** Pastes at or under this size (UTF-8 bytes) are inlined in full. */
export const PASTE_INLINE_MAX_BYTES = 50 * 1024

export function pasteFilePath(sessionID: string, id: string) {
  return path.join(Global.Path.data, PASTE_FILE_DIRECTORY, sessionID, `paste-${id}.txt`)
}

/**
 * Bounded preview of a large paste: head and tail within the inline budget,
 * with a marker pointing at the full file in between (same convention as
 * ToolOutputStore's truncated-output marker).
 */
export function pastePreview(content: string, filePath: string): string {
  const marker = `... content truncated; full content saved to ${filePath} ...`
  const budget = PASTE_INLINE_MAX_BYTES - Buffer.byteLength(marker, "utf-8") - 4
  if (budget <= 0) return marker
  const half = Math.floor(budget / 2)
  const head = takePrefix(content, half)
  const tail = takeSuffix(content, half)
  if (tail) return `${head}\n\n${marker}\n\n${tail}`
  return `${head}\n\n${marker}`
}

/**
 * Writes the full pasted content to the managed paste file. Never fails:
 * returns `undefined` when the write is impossible so the caller can fall
 * back to inlining the content (the paste must never be dropped).
 */
export function writePasteFile(fsys: FSUtil.Interface, sessionID: string, id: string, content: string) {
  const file = pasteFilePath(sessionID, id)
  return fsys
    .writeWithDirs(file, content)
    .pipe(
      Effect.map(() => file as string | undefined),
      Effect.catch((error) =>
        Effect.logWarning("failed to write pasted text file, falling back to inline content", {
          file,
          error: String(error),
        }).pipe(Effect.as(undefined)),
      ),
    )
}
