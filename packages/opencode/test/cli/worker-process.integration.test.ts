import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createWorkerProcess } from "../../src/cli/tui/worker-process"
import { Rpc } from "../../src/util/rpc"

const workerSource = `
process.on("message", (message) => {
  if (message === "ping") process.send?.("pong")
  // process.abort() dies abnormally on every platform: SIGABRT where POSIX
  // signals exist, exit code 134 where they do not (Windows). Both classify
  // as a crash; process.kill(pid, "SIGSEGV") throws on Windows instead.
  if (message === "crash") process.abort()
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`

const rpcWorkerSource = `
process.on("message", (message) => {
  if (message === "crash") {
    process.abort()
    return
  }
  let parsed
  try {
    parsed = JSON.parse(message)
  } catch {
    return
  }
  if (parsed?.type !== "rpc.request" || parsed.id === undefined) return
  // "hang" never replies: used to strand a call across a crash.
  if (parsed.method === "hang") return
  if (parsed.method === "work") {
    process.send?.(JSON.stringify({ type: "rpc.result", id: parsed.id, result: "done" }))
  }
})
setTimeout(() => process.send?.("ready"), 50)
setInterval(() => {}, 1000)
`

async function waitForCount(messages: string[], text: string, count: number, what: string) {
  const deadline = Date.now() + 5000
  for (;;) {
    if (messages.filter((message) => message === text).length >= count) return
    if (Date.now() > deadline) throw new Error(`${what} (saw ${messages.length} messages)`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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
      await waitForCount(messages, "ready", 1, "worker did not start")

      worker.postMessage("ping")
      await waitForCount(messages, "pong", 1, "worker did not reply")

      worker.postMessage("crash")
      const restarted = worker.waitForRestart()
      await restarted
      // Restart completion is not readiness: the replacement announces
      // itself separately once it is actually usable.
      await waitForCount(messages, "ready", 2, "replacement worker never became ready")

      worker.postMessage("ping")
      await waitForCount(messages, "pong", 2, "replacement worker did not reply")

      expect(messages.filter((message) => message === "ready")).toHaveLength(2)
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a stranded RPC across a crash and serves new calls after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alphacode-worker-rpc-"))
    const target = join(dir, "worker.ts")
    await Bun.write(target, rpcWorkerSource)

    const worker = createWorkerProcess(target, {
      onRestart: () => {},
      log: () => {},
      maxRestarts: 1,
    })
    const client = Rpc.client<{ work(input: undefined): string; hang(input: undefined): string }>(worker)

    // A call issued while the replacement is still booting may be dropped;
    // retry with bounded attempts until the worker answers.
    async function callWorkSoon(): Promise<string> {
      const deadline = Date.now() + 5000
      for (;;) {
        const attempt = client.call("work", undefined)
        const settled = await Promise.race([
          attempt.then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const }),
          ),
          new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 200)),
        ])
        if (settled.ok) return settled.value
        if (Date.now() > deadline) throw new Error("replacement worker never answered")
      }
    }

    try {
      await expect(callWorkSoon()).resolves.toBe("done")

      const hanging = client.call("hang", undefined)
      let hangingSettled: string | undefined
      void hanging.then(
        () => {
          hangingSettled = "resolved"
        },
        () => {
          hangingSettled = "rejected"
        },
      )
      worker.postMessage("crash")
      const restarted = worker.waitForRestart()
      await expect(hanging).rejects.toThrow(/exited with/)
      expect(hangingSettled).toBe("rejected")
      await restarted

      await expect(callWorkSoon()).resolves.toBe("done")
    } finally {
      await worker.terminate()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
