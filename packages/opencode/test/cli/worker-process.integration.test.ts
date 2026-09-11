import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createWorkerProcess } from "../../src/cli/tui/worker-process"

const workerSource = `
process.on("message", (message) => {
  if (message === "ping") process.send?.("pong")
  if (message === "crash") process.kill(process.pid, "SIGSEGV")
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`

describe("TUI worker process integration", () => {
  test("communicates over real Bun IPC and reconnects after a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alphacode-worker-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, workerSource)

    const messages: string[] = []
    const worker = createWorkerProcess(target, {
      onRestart: () => {},
      log: () => {},
      maxRestarts: 1,
    })
    worker.onmessage = (event) => messages.push(event.data)

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("worker did not start")), 5000)
        const poll = () => {
          if (messages.includes("ready")) {
            clearTimeout(timeout)
            resolve()
            return
          }
          setTimeout(poll, 10)
        }
        poll()
      })

      worker.postMessage("ping")
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("worker did not reply")), 5000)
        const poll = () => {
          if (messages.includes("pong")) {
            clearTimeout(timeout)
            resolve()
            return
          }
          setTimeout(poll, 10)
        }
        poll()
      })

      worker.postMessage("crash")
      await worker.restarted

      const readyCount = messages.filter((message) => message === "ready").length
      expect(readyCount).toBe(2)
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
