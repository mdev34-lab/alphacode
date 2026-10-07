// Runs the real worker.ts thread entrypoint in a clean bun process. Probes
// bootstrap by driving the real "snapshot" RPC method: on receipt the worker
// thread synchronously writes server.heapsnapshot into its cwd. The snapshot
// file's presence is polled on the filesystem, so the probe is immune to
// bun's flaky in-process message-event delivery on some hosts. Prints
// RESULT:snapshot when the marked worker handles a request, RESULT:closed when
// the unmarked worker exits without registering RPC, RESULT:no-rpc if it stays
// alive without handling a request, or RESULT:error for a worker failure.
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const marker = process.argv[2] === "1"
const windowMs = Number(process.argv[3] ?? 20000)

const heapFile = join(process.cwd(), "server.heapsnapshot")
rmSync(heapFile, { force: true })

const worker = new Worker(new URL("../../src/cli/tui/worker.ts", import.meta.url), {
  env: {
    ...process.env,
    ...(marker ? { ALPHACODE_TUI_WORKER: "1" } : {}),
  },
})

let error: string | undefined
let sawSnapshot = false
let workerClosed = false
worker.addEventListener("error", (event) => {
  error = String((event as unknown as { message: string }).message)
})

let requestId = 0
const deadline = Date.now() + windowMs
while (Date.now() < deadline && !sawSnapshot && !error && !workerClosed) {
  try {
    worker.postMessage(JSON.stringify({ type: "rpc.request", id: ++requestId, method: "snapshot", input: undefined }))
  } catch (cause) {
    if (cause instanceof Error && cause.name === "InvalidStateError") {
      workerClosed = true
      break
    }
    error = String(cause)
    break
  }
  // Wait for the thread to handle the request and write the snapshot file.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (existsSync(heapFile)) {
      sawSnapshot = true
      break
    }
  }
}

// A postMessage racing normal termination can be accepted before the first
// follow-up poll sees either its snapshot or the worker close; probe again so
// a closed worker is not mistaken for a live worker with no RPC listener.
if (!marker && !sawSnapshot && !error && !workerClosed) {
  try {
    worker.postMessage(JSON.stringify({ type: "rpc.request", id: ++requestId, method: "snapshot", input: undefined }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    sawSnapshot = existsSync(heapFile)
    if (!sawSnapshot) {
      worker.postMessage(JSON.stringify({ type: "rpc.request", id: ++requestId, method: "snapshot", input: undefined }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      sawSnapshot = existsSync(heapFile)
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name === "InvalidStateError") workerClosed = true
    else error = String(cause)
  }
}

worker.terminate()
rmSync(heapFile, { force: true })
const result = error ? `error:${error.slice(0, 120)}` : sawSnapshot ? "snapshot" : workerClosed ? "closed" : "no-rpc"
console.log(`RESULT:${result}`)
const expected = marker ? sawSnapshot : !error && workerClosed && !sawSnapshot
if (!expected) process.exitCode = 1
