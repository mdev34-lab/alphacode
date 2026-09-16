import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { resolveIsTuiWorker } from "../../src/cli/tui/worker"

const driver = fileURLToPath(new URL("./worker-bootstrap-driver.ts", import.meta.url))

function runDriver(marker: boolean, windowMs: number) {
  const result = Bun.spawnSync([process.execPath, driver, marker ? "1" : "0", String(windowMs)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  }
}

describe("TUI worker bootstrap", () => {
  test("worker identity is the launch marker or process IPC, independently of transport", () => {
    expect(resolveIsTuiWorker({ ALPHACODE_TUI_WORKER: "1" }, false)).toBe(true)
    expect(resolveIsTuiWorker({}, false)).toBe(false)
    expect(resolveIsTuiWorker({}, true)).toBe(true)
  })

  test(
    "a thread worker with the launch marker boots and answers RPC (compiled-binary path)",
    () => {
      const { stdout, stderr, exitCode } = runDriver(true, 30000)
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(stdout).toContain("RESULT:snapshot")
    },
    { timeout: 120000 },
  )

  test(
    "a thread worker without the marker registers no RPC listener (the black-screen regression)",
    () => {
      const { stdout, stderr, exitCode } = runDriver(false, 15000)
      expect(stderr).toBe("")
      expect(stdout).toContain("RESULT:none")
    },
    { timeout: 120000 },
  )
})