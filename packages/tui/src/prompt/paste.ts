/**
 * Client-side "Paste to File" for the prompt composer.
 *
 * When the user pastes a document-sized text payload into the composer, we do
 * not flood the message with it: the payload is captured as a `text/plain`
 * file part (a `data:text/plain;base64` URL) and a compact placeholder is
 * inserted at the cursor instead. On submit the file part is sent with the
 * prompt and the server (see packages/opencode/src/session/paste-file.ts)
 * inlines it or saves it to the managed attachment store, so the agent can
 * read the full content as a file.
 *
 * The large-paste thresholds are carried over from the paste classifier of
 * the former web composer (packages/app/src/components/prompt-input/paste.ts):
 * a paste is "large" at 8000+ characters or 120+ line breaks. Smaller pastes
 * keep the existing behavior (paste summary or plain insertion).
 */
import type { FilePart } from "@opencode-ai/sdk/v2"

export const LARGE_PASTE_CHARS = 8000
export const LARGE_PASTE_BREAKS = 120

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
