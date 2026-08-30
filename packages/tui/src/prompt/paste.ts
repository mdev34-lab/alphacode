/**
 * Client-side "Paste to File" for the prompt composer.
 *
 * When the user pastes a text payload into the composer we capture it as a
 * `text/plain` file part (a `data:text/plain;base64` URL) so the model
 * receives the full content through the file-attachment path rather than
 * embedded in a text part. The composer shows a compact placeholder instead
 * of the full text. On submit the file part is sent with the prompt and the
 * server (see packages/opencode/src/session/paste-file.ts) inlines it or
 * saves it to the managed attachment store, so the agent can read the full
 * content as a file.
 *
 * Thresholds:
 *   - `LARGE_PASTE_CHARS` (8000) and `LARGE_PASTE_BREAKS` (120) are the
 *     historical "definitely large" thresholds inherited from the former web
 *     composer.
 *   - `LARGE_PASTE_FILE_BYTES` (2048) is the lower bound at which a paste
 *     becomes a file attachment. It bridges the gap between the
 *     composer-summary threshold (~150 chars) and `LARGE_PASTE_CHARS`, so
 *     medium pastes (a few KB of code/log/config) are also captured as
 *     attachments rather than being sent inline as a text part.
 */
import type { FilePart } from "@opencode-ai/sdk/v2"

export const LARGE_PASTE_CHARS = 8000
export const LARGE_PASTE_BREAKS = 120
export const LARGE_PASTE_FILE_BYTES = 2048

export function isLargePaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

/**
 * Pastes at or above this size always become a file attachment when
 * `summaryEnabled` is true, regardless of whether they meet the historical
 * `isLargePaste` thresholds. This is the entry point for medium-sized
 * pastes (a few KB of code, logs, config) that should not flood the message.
 */
export function isPasteAsFile(text: string): boolean {
  if (isLargePaste(text)) return true
  return text.length >= LARGE_PASTE_FILE_BYTES
}

/** Compact composer placeholder shown where the large paste was captured. */
export function pastedFilePlaceholder(index: number): string {
  return `[Pasted file ${index}]`
}

/**
 * Builds the file part that carries a captured large paste. The `index`
 * numbers pasted files within the current prompt draft (paste-1.txt,
 * paste-2.txt, ...), mirroring the `[Image N]` / `[PDF N]` attachment
 * convention.
 */
export function pastedFilePart(input: {
  text: string
  index: number
  start: number
  end: number
}): Omit<FilePart, "id" | "messageID" | "sessionID"> {
  const value = pastedFilePlaceholder(input.index)
  return {
    type: "file",
    mime: "text/plain",
    filename: `paste-${input.index}.txt`,
    url: `data:text/plain;base64,${Buffer.from(input.text, "utf8").toString("base64")}`,
    source: {
      type: "file",
      path: "",
      text: {
        start: input.start,
        end: input.end,
        value,
      },
    },
  }
}
