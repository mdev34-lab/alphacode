import type { Provider } from "@opencode-ai/sdk/v2"

export type ModelLike =
  | {
      capabilities?: {
        input?: { image?: boolean } | ReadonlyArray<string> | string[]
      }
    }
  | undefined
  | null

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? modelID
}

export function supportsVision(model: ModelLike) {
  if (!model?.capabilities?.input) return false
  const input = model.capabilities.input
  if (Array.isArray(input)) {
    return input.includes("image")
  }
  if (typeof input === "object") {
    return (input as { image?: boolean }).image === true
  }
  return false
}

export type TurnModel = {
  parentID?: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

export function effectiveVariant(value?: string) {
  return value && value !== "default" ? value : undefined
}

// Decides whether an assistant turn actually ran with a different model or
// thinking effort than the previous assistant turn. Turns from a different
// task (different parent message) or runs by another agent (subagent turns)
// are never compared, so ordinary user-message boundaries and subagent model
// differences do not produce markers.
export function modelSwitch(previous: TurnModel | undefined, current: TurnModel) {
  if (!previous || previous.parentID !== current.parentID || previous.agent !== current.agent) return undefined
  const sameModel = previous.providerID === current.providerID && previous.modelID === current.modelID
  if (sameModel && effectiveVariant(previous.variant) === effectiveVariant(current.variant)) return undefined
  return { variant: effectiveVariant(current.variant) }
}
