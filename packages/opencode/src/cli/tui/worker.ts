import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

// Subscribe to global events and forward them via RPC
const onGlobalEvent = (event: Parameters<typeof GlobalBus.emitEvent>[0]) => {
  if (processWorker) {
    Rpc.emitProcess("global.event", event)
  } else {
    Rpc.emit("global.event", event)
  }
}

// Whether this module talks to its parent over process IPC (spawned as a
// child process) or over thread messaging (Bun Worker in a compiled binary,
// which has no `process.send`).
const processWorker = typeof process.send === "function"

// Whether this module is running as the TUI worker host rather than being
// imported as a library. Gated on the explicit launch marker (set by both
// spawn modes in worker-process.ts) or the child-process fallback for
// environments that spawn worker.ts directly. `import.meta.main` is NOT a
// reliable signal: a compiled Bun binary runs every secondary entrypoint
// (the thread worker) with `import.meta.main === false`.
const isTuiWorker = process.env["ALPHACODE_TUI_WORKER"] === "1" || processWorker

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
let stopRpcListener: (() => void) | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    stopRpcListener?.()
    stopRpcListener = undefined
    GlobalBus.off("event", onGlobalEvent)
    await InstanceRuntime.disposeAllInstances()
    if (server) {
      await server.stop(true)
      server = undefined
    }
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

if (isTuiWorker) {
  Heap.start()
  process.on("unhandledRejection", onUnhandledRejection)
  process.on("uncaughtException", onUncaughtException)
  GlobalBus.on("event", onGlobalEvent)

  if (processWorker) {
    stopRpcListener = Rpc.listenProcess(rpc)
  } else {
    stopRpcListener = Rpc.listen(rpc)
  }
}
