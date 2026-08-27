export * as RuntimeFlags from "./runtime-flags"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "./app-node"

export interface Interface {
  readonly factoryDefault: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeFlags") {}

const envDefault = process.env.OPENCODE_FACTORY_DEFAULT === "1" || process.env.OPENCODE_FACTORY_DEFAULT === "true"

export const layerWith = (input: Partial<Interface> = {}): Layer.Layer<Service> =>
  Layer.succeed(Service, Service.of({ factoryDefault: envDefault, ...input }))

export const layer: Layer.Layer<Service> = layerWith()

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
