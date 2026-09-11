import { describe, expect, test } from "bun:test"
import { createWorkerProcess } from "../../src/cli/tui/worker-process"

type FakeProcess = {
  exitCode: number | null
  signalCode: string | null
  exited: Promise<number>
  send(message: string): void
  kill(signal?: string | number): void
  disconnect(): void
  resolveExit(code: number, signal?: string): void
  signals: (string | number)[]
}

function fakeProcess(): FakeProcess {
  let resolveExit!: (code: number) => void
  const child: FakeProcess = {
    exitCode: null,
    signalCode: null,
    exited: new Promise((resolve) => {
      resolveExit = resolve
    }),
    signals: [],
    send() {},
    kill(signal) {
      this.signals.push(signal ?? "SIGTERM")
      this.resolveExit(0, typeof signal === "string" ? signal : undefined)
    },
    disconnect() {},
    resolveExit(code, signal) {
      this.exitCode = code
      this.signalCode = signal ?? null
      resolveExit(code)
    },
  }
  return child
}

describe("worker process signal lifecycle", () => {
  test("forwarded termination signals do not leave the parent responsible for cleanup", async () => {
    const child = fakeProcess()
    const worker = createWorkerProcess("worker.ts", {
      spawn: () => child,
      log: () => {},
    })

    // The actual parent handler lives in tui.ts; this verifies the worker-side
    // contract that receiving a termination signal cannot silently trigger a
    // crash restart.
    worker.signal("SIGTERM")
    expect(child.signals).toEqual(["SIGTERM"])
    child.resolveExit(0)
    await expect(worker.closed).resolves.toEqual({ code: 0, signal: "SIGTERM" })
    await worker.terminate()
  })
})
