import { Agent } from "@opencode-ai/schema/agent"

export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  const byName = (value: string | undefined) => (value === undefined ? undefined : items.find((i) => i.name === value))
  return (
    byName(name) ??
    // `build` is the legacy id of `work`: persisted preferences and old
    // sessions still reference it.
    byName(name === undefined ? undefined : Agent.LEGACY_IDS[name]) ??
    byName(Agent.DEFAULT_ID) ??
    items[0]
  )
}
