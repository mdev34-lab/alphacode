/**
 * Shared media shape passed between the Qwen adapter layers.
 *
 * Lives here (not in the prompt renderer) because `upload` — which is part of
 * the Qwen protocol client — needs it without a dependency on the provider's
 * AI-SDK prompt renderer.
 */
export interface QwenWebMedia {
  /** data URL, remote URL, or raw base64 with a media type. */
  source: string
  mediaType?: string
  filename?: string
}