import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

function waitForStdinEnd(stdin: NodeJS.ReadStream) {
  if (stdin.errored) return Promise.reject(stdin.errored)
  if (stdin.readableEnded || stdin.destroyed) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stdin.off("end", onEnd)
      stdin.off("error", onError)
      stdin.off("close", onClose)
    }
    const onEnd = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      resolve()
    }

    stdin.once("end", onEnd)
    stdin.once("error", onError)
    stdin.once("close", onClose)
    if (stdin.errored) onError(stdin.errored)
    else if (stdin.readableEnded || stdin.destroyed) onEnd()
  })
}

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.OPENCODE_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    yield* Effect.gen(function* () {
      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        headers: ServerAuth.headers(),
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          const stdin = process.stdin
          if (stdin.errored) {
            controller.error(stdin.errored)
            return
          }
          if (stdin.readableEnded || stdin.destroyed) {
            controller.close()
            return
          }
          stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          stdin.on("end", () => controller.close())
          stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        ACPProfile.mark("cli.acp.connection.create")
        return agent.create(conn)
      }, stream)

      const stdinEnded = yield* Effect.sync(() => waitForStdinEnd(process.stdin))
      yield* Effect.logInfo("setup connection")
      yield* Effect.sync(() => process.stdin.resume())
      yield* Effect.promise(() => stdinEnded)
    }).pipe(Effect.ensuring(Effect.promise(() => server.stop())))
  }),
})
