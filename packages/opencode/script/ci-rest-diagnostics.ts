// Temporary diagnostics: retain the original test argv and exit status.
import { appendFileSync } from "node:fs"
import path from "node:path"

const started = Date.now()
// This prior step's log is already uploaded by the unchanged workflow.
// Its tee process has exited before rest begins, so append has no competing writer.
// Do not use ci-rest-test.log: the current step's tee writes that same file
// with an independent offset and can overwrite direct diagnostic appends.
const logPath = path.join(import.meta.dir, "../ci-session-prompt-test.log")
let child: ReturnType<typeof Bun.spawn> | undefined
let stdoutBytes = 0
let stderrBytes = 0
function log(event: string, detail: Record<string, unknown> = {}) {
  const line = `[rest-process] ${JSON.stringify({
    event, at: new Date().toISOString(), elapsedMs: Date.now() - started,
    pid: process.pid, ppid: process.ppid, childPid: child?.pid,
    stdoutBytes, stderrBytes, ...detail,
  })}\n`
  appendFileSync(logPath, line)
  process.stderr.write(line)
}
log("wrapper-start", { argv: process.argv.slice(2) })
const argv = process.argv.slice(2)
const heartbeat = setInterval(() => log("pending"), 30_000)
heartbeat.unref()
try {
  child = Bun.spawn([process.execPath, "test", ...argv], {
    cwd: process.cwd(), env: process.env, stdin: "inherit", stdout: "pipe", stderr: "pipe",
  })
  log("child-spawned")
  const forward = async (source: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") => {
    const reader = source.getReader()
    let first = true
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        if (kind === "stdout") stdoutBytes += result.value.length
        else stderrBytes += result.value.length
        if (first) { first = false; log("first-output", { stream: kind }) }
        appendFileSync(logPath, `[child-${kind}] `)
        appendFileSync(logPath, result.value)
        if (kind === "stdout") process.stdout.write(result.value)
        else process.stderr.write(result.value)
      }
    } finally { reader.releaseLock() }
    log("stream-closed", { stream: kind })
  }
  const output = [forward(child.stdout, "stdout"), forward(child.stderr, "stderr")]
  const code = await child.exited
  log("child-exited", { code, signalCode: child.signalCode })
  await Promise.all(output)
  log("wrapper-complete", { code })
  process.exitCode = code
} finally {
  clearInterval(heartbeat)
}
