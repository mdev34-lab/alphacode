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
// thinking effort than the previous assistant turn of the same task. The
// comparison target is the nearest earlier turn with the same parent message
// and agent, so user-message boundaries and subagent turns interleaved in
// between never produce markers and cannot hide a real switch.
export function modelSwitch(previousTurns: TurnModel[] | undefined, current: TurnModel) {
  const previous = previousTurns
    ?.filter((turn) => turn.parentID === current.parentID && turn.agent === current.agent)
    .at(-1)
  if (!previous) return undefined
  const sameModel = previous.providerID === current.providerID && previous.modelID === current.modelID
  if (sameModel && effectiveVariant(previous.variant) === effectiveVariant(current.variant)) return undefined
  return { variant: effectiveVariant(current.variant) }
}
