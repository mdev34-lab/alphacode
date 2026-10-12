import { describe, expect, test } from "bun:test"
import { Terminal } from "bun-pty"

type Exit = { exitCode: number }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
// These tests spawn a POSIX shell in /tmp, like ptyTest in pty-session.test.ts.
// Explicit per-test budget (20s) above the 10s helper deadline: bun:test defaults to 5s,
// which under CI load would cut the test off before until() could report what it waited for.
const BUDGET = 20_000
const ptyTest = process.platform === "win32" ? test.skip : test

async function until(condition: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
// Always release the native handle and stop the read loop, even when a wait fails.
// kill() on an already-exited child is harmless; it closes the handle.
const release = (term: Terminal) => {
  ;(term as unknown as { _readLoop: boolean })._readLoop = false
  try {
    term.kill()
  } catch {}
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH"
  }
}

// Builds a Terminal whose exit is cached by the REAL read-loop branch: the
// constructor's loop is stopped, the child exits, then the loop is restarted
// by hand so its first read sees CHILD_EXITED while nobody is subscribed
// (the fire-before-register race from issue 274, made deterministic).
async function exitedWithoutListeners() {
  const term = new Terminal("/usr/bin/env", ["sh", "-c", "sleep 0.2; exit 3"], { name: "xterm-256color", cwd: "/tmp", env: {} })
  const internals = term as unknown as { _readLoop: boolean; _startReadLoop: () => Promise<void> }
  try {
    internals._readLoop = false
    await until(() => gone(term.pid), "child exit")
    await internals._startReadLoop()
    return term
  } catch (error) {
    release(term)
    throw error
  }
}

const spawnDirect = () =>
  new Terminal("/usr/bin/env", ["sh", "-c", "sleep 0.2; exit 3"], { name: "xterm-256color", cwd: "/tmp", env: {} })

// Runs body against a terminal and always releases it, including on failure/timeout.
async function withTerminal(make: () => Terminal | Promise<Terminal>, body: (term: Terminal) => Promise<void>) {
  const term = await make()
  try {
    await body(term)
  } finally {
    release(term)
  }
}

describe("bun-pty exit replay", () => {
  ptyTest(
    "replays a cached exit once, asynchronously, to the first subscriber only",
    () =>
      withTerminal(exitedWithoutListeners, async (term) => {
        const first: Array<{ e: Exit; sync: boolean }> = []
        let sync = true
        term.onExit((e) => first.push({ e, sync }))
        sync = false
        expect(first).toEqual([])
        await tick()
        expect(first).toEqual([{ e: { exitCode: 3 }, sync: false }])
        const second: Exit[] = []
        term.onExit((e) => second.push(e))
        await tick()
        expect(second).toEqual([])
      }),
    BUDGET,
  )

  ptyTest(
    "dispose before the replay microtask cancels delivery and keeps the exit pending",
    () =>
      withTerminal(exitedWithoutListeners, async (term) => {
        const calls: Exit[] = []
        term.onExit((e) => calls.push(e)).dispose()
        await tick()
        expect(calls).toEqual([])
        const later: Exit[] = []
        term.onExit((e) => later.push(e))
        await tick()
        expect(later).toEqual([{ exitCode: 3 }])
      }),
    BUDGET,
  )

  ptyTest(
    "a listener present at exit time is called directly without caching",
    () =>
      withTerminal(spawnDirect, async (term) => {
        const calls: Exit[] = []
        term.onExit((e) => calls.push(e))
        await until(() => calls.length > 0, "direct exit delivery")
        expect(calls).toEqual([{ exitCode: 3 }])
        const late: Exit[] = []
        term.onExit((e) => late.push(e))
        await tick()
        expect(late).toEqual([])
      }),
    BUDGET,
  )

  ptyTest(
    "dispose then an immediate second subscribe (before the microtask) still gets the exit",
    () =>
      withTerminal(exitedWithoutListeners, async (term) => {
        const first: Exit[] = []
        const second: Array<{ e: Exit; sync: boolean }> = []
        term.onExit((e) => first.push(e)).dispose()
        let sync = true
        term.onExit((e) => second.push({ e, sync }))
        sync = false
        await tick()
        await tick()
        expect(first).toEqual([])
        expect(second).toEqual([{ e: { exitCode: 3 }, sync: false }])
      }),
    BUDGET,
  )

  ptyTest(
    "a throwing replay listener is reported on stderr, not as an unhandled error, and the exit is consumed",
    () =>
      withTerminal(exitedWithoutListeners, async (term) => {
        const reported: unknown[][] = []
        const unhandled: unknown[] = []
        const original = console.error
        const onUnhandled = (error: unknown) => unhandled.push(error)
        console.error = (...args: unknown[]) => void reported.push(args)
        process.on("unhandledRejection", onUnhandled)
        process.on("uncaughtException", onUnhandled)
        try {
          term.onExit(() => {
            throw new Error("listener boom")
          })
          await tick()
          await tick()
        } finally {
          console.error = original
          process.off("unhandledRejection", onUnhandled)
          process.off("uncaughtException", onUnhandled)
        }
        expect(unhandled).toEqual([])
        expect(reported.length).toBe(1)
        expect(String(reported[0]?.[0])).toContain("replayed exit listener threw")
        expect((reported[0]?.[1] as Error).message).toBe("listener boom")
        const later: Exit[] = []
        term.onExit((e) => later.push(e))
        await tick()
        expect(later).toEqual([])
      }),
    BUDGET,
  )

  ptyTest(
    "disposing the only live listener before exit makes the exit cacheable again",
    () =>
      withTerminal(
        async () => {
          const term = new Terminal("/usr/bin/env", ["sh", "-c", "sleep 0.2; exit 3"], {
            name: "xterm-256color",
            cwd: "/tmp",
            env: {},
          })
          const internals = term as unknown as { _readLoop: boolean; _startReadLoop: () => Promise<void> }
          try {
            term.onExit(() => {}).dispose()
            internals._readLoop = false
            await until(() => gone(term.pid), "child exit")
            await internals._startReadLoop()
            return term
          } catch (error) {
            release(term)
            throw error
          }
        },
        async (term) => {
          const calls: Exit[] = []
          term.onExit((e) => calls.push(e))
          await tick()
          expect(calls).toEqual([{ exitCode: 3 }])
        },
      ),
    BUDGET,
  )
})
