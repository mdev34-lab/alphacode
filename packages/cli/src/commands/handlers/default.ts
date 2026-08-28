import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    if (input["factory-default"]) {
      process.env.OPENCODE_FACTORY_DEFAULT = "1"
    }
    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()
    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(transport)
  }),
)
