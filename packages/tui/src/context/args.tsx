import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  /** Agent inferred from the launch directory; applied only when no agent was requested or configured. */
  inferredAgent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
  yolo?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
