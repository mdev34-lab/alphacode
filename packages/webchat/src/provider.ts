/**
 * Provider interface + registry for the webchat backbone.
 *
 * Adapters implement `WebChatProvider`; the registry lets callers resolve a
 * provider by id. The Qwen adapter registers itself on import.
 */
import type { WebChatProvider } from "./types"

export type WebChatProviderFactory = (options?: Record<string, unknown>) => WebChatProvider

const factories = new Map<string, WebChatProviderFactory>()
const instances = new Map<string, WebChatProvider>()

export function registerWebChatProvider(id: string, factory: WebChatProviderFactory): void {
  factories.set(id, factory)
}

export function unregisterWebChatProvider(id: string): void {
  factories.delete(id)
  instances.delete(id)
}

export function webChatProviderFor(id: string, options?: Record<string, unknown>): WebChatProvider | undefined {
  const existing = instances.get(id)
  if (existing) return existing
  const factory = factories.get(id)
  if (!factory) return undefined
  const provider = factory(options)
  instances.set(id, provider)
  return provider
}

export function registeredWebChatProviders(): string[] {
  return [...factories.keys()]
}