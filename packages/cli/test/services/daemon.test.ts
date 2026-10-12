import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

// The daemon state directory is resolved from XDG_STATE_HOME when the module is
// first imported, so the isolated directory must be set before the import.
const stateHome = mkdtempSync(path.join(tmpdir(), "alphacode-daemon-test-"))
process.env.XDG_STATE_HOME = stateHome
const serverFile = path.join(stateHome, "opencode", "server.json")
const markerScript = path.join(stateHome, "spawn-marker.js")
const markerOut = path.join(stateHome, "spawn-marker.out")

import type { Interface as DaemonInterface } from "../../src/services/daemon"

type DaemonModule = typeof import("../../src/services/daemon")
let mod: DaemonModule
let installationVersion: string

beforeAll(async () => {
  mod = await import("../../src/services/daemon")
  installationVersion = (await import("@opencode-ai/core/installation/version")).InstallationVersion
  // Replacement path spawns `<execPath> <argv[1]> serve --register`. The marker
  // records that a spawn happened and exits, instead of starting a real server.
  writeFileSync(markerScript, 'require("fs").writeFileSync(process.env.ALPHACODE_TEST_MARK, process.argv.slice(2).join(" "))\n')
})

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true })
})

describe("decideStart", () => {
  const base = { registered: true, sameVersion: true, compiled: true, factoryDefault: false }

  test("spawns when nothing is registered, whatever the probe says", () => {
    expect(mod.decideStart({ ...base, registered: false, activeRuns: undefined })).toBe("spawn")
    expect(mod.decideStart({ ...base, registered: false, activeRuns: 3 })).toBe("spawn")
  })

  test("unknown probe result always refuses and never stops or reuses", () => {
    for (const sameVersion of [true, false]) {
      for (const compiled of [true, false]) {
        for (const factoryDefault of [true, false]) {
          expect(mod.decideStart({ ...base, sameVersion, compiled, factoryDefault, activeRuns: undefined })).toBe(
            "refuse-unknown",
          )
        }
      }
    }
  })

  test("active runs: same-version reuses, version mismatch refuses", () => {
    expect(mod.decideStart({ ...base, activeRuns: 1 })).toBe("reuse")
    expect(mod.decideStart({ ...base, compiled: false, activeRuns: 1 })).toBe("reuse")
    expect(mod.decideStart({ ...base, sameVersion: false, activeRuns: 1 })).toBe("refuse-active")
  })

  test("verified idle zero: reuses a same-version compiled service, replaces otherwise", () => {
    expect(mod.decideStart({ ...base, activeRuns: 0 })).toBe("reuse")
    expect(mod.decideStart({ ...base, compiled: false, activeRuns: 0 })).toBe("replace")
    expect(mod.decideStart({ ...base, factoryDefault: true, activeRuns: 0 })).toBe("replace")
    expect(mod.decideStart({ ...base, sameVersion: false, activeRuns: 0 })).toBe("replace")
  })
})

describe("decideRestart", () => {
  test("proceeds when nothing is registered", () => {
    expect(mod.decideRestart({ registered: false, activeRuns: undefined })).toBe("proceed")
  })

  test("unknown probe result refuses", () => {
    expect(mod.decideRestart({ registered: true, activeRuns: undefined })).toBe("refuse-unknown")
  })

  test("proceeds only when verified idle; refuses with active runs", () => {
    expect(mod.decideRestart({ registered: true, activeRuns: 0 })).toBe("proceed")
    expect(mod.decideRestart({ registered: true, activeRuns: 1 })).toBe("refuse-active")
  })
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type ActiveMode =
  | { kind: "ok"; runs: number }
  | { kind: "status"; status: number }
  | { kind: "body"; text: string }
  | { kind: "hang" }
  | { kind: "drop" }

// Fake registered server. /api/health is always healthy so the probe is the only
// variable; /api/session/active behaves according to `active`.
function fakeServer(active: ActiveMode) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ healthy: true })
      if (url.pathname !== "/api/session/active") return new Response("not found", { status: 404 })
      if (active.kind === "ok") {
        const sessions = Object.fromEntries(
          Array.from({ length: active.runs }, (_, i) => [`ses_test_${i}`, { type: "running" }]),
        )
        return Response.json({ data: sessions })
      }
      if (active.kind === "status") return new Response("nope", { status: active.status })
      if (active.kind === "body") return new Response(active.text, { status: 200 })
      if (active.kind === "drop") return Response.error() // connection-level failure; listener stays up
      return new Promise<Response>(() => {}) // hang: the client's 2 s timeout must fire
    },
  })
  return server
}

function writeRegistration(input: { version: string; url: string; pid: number }) {
  mkdirSync(path.dirname(serverFile), { recursive: true })
  writeFileSync(serverFile, JSON.stringify({ id: randomUUID(), ...input }))
}

type Outcome = { ok: true; value: unknown } | { ok: false; message: string }

function runDaemon<A, E>(program: (daemon: DaemonInterface) => Effect.Effect<A, E, never>): Promise<Outcome> {
  const layer = mod.layer.pipe(Layer.provide(NodeFileSystem.layer))
  const outcome = Effect.gen(function* () {
    const daemon = yield* mod.Service
    yield* daemon.password("test-password")
    return yield* program(daemon)
  }).pipe(
    Effect.match({
      onFailure: (error): Outcome => ({ ok: false, message: errorText(error) }),
      onSuccess: (value): Outcome => ({ ok: true, value }),
    }),
  )
  return Effect.runPromise(Effect.provide(outcome, layer))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function withRegisteredService(
  active: ActiveMode,
  version: string,
  body: (ctx: { child: ReturnType<typeof Bun.spawn>; url: string }) => Promise<void>,
) {
  const server = fakeServer(active)
  const url = server.url.origin
  // A real process stands in for the registered server so a stop is observable.
  const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
  writeRegistration({ version, url, pid: child.pid })
  try {
    await body({ child, url })
    // Every refusal must leave the registered process and its registration in place.
    expect(alive(child.pid)).toBe(true)
    expect(existsSync(serverFile)).toBe(true)
  } finally {
    child.kill()
    server.stop(true)
    rmSync(serverFile, { force: true })
  }
}

describe("daemon start/restart: verified active-run boundary (integration)", () => {
  test("active run on a same-version service: start reuses, restart refuses, process stays alive", async () => {
    await withRegisteredService({ kind: "ok", runs: 1 }, installationVersion, async ({ url }) => {
      const started = await runDaemon((daemon) => daemon.start())
      expect(started.ok).toBe(true)
      if (started.ok) expect(started.value).toBe(url)

      const restarted = await runDaemon((daemon) => daemon.restart())
      expect(restarted.ok).toBe(false)
      if (!restarted.ok) expect(restarted.message).toContain("1 active run(s)")
    })
  }, 60_000)

  const unknownCases: Array<{ name: string; active: ActiveMode }> = [
    { name: "HTTP 401 (auth mismatch)", active: { kind: "status", status: 401 } },
    { name: "HTTP 404", active: { kind: "status", status: 404 } },
    { name: "HTTP 500", active: { kind: "status", status: 500 } },
    { name: "2xx with a body that does not decode", active: { kind: "body", text: "not-json" } },
    { name: "timeout (no response)", active: { kind: "hang" } },
    { name: "network error (connection dropped)", active: { kind: "drop" } },
  ]

  for (const item of unknownCases) {
    test(`unknown probe (${item.name}): start and restart refuse, process and registration kept`, async () => {
      await withRegisteredService(item.active, installationVersion, async () => {
        const started = await runDaemon((daemon) => daemon.start())
        expect(started.ok).toBe(false)
        if (!started.ok) expect(started.message).toContain("Could not confirm")

        const restarted = await runDaemon((daemon) => daemon.restart())
        expect(restarted.ok).toBe(false)
        if (!restarted.ok) expect(restarted.message).toContain("Could not confirm")
      })
    }, 60_000)
  }

  test("unknown probe on a version-mismatched service: start refuses, process kept", async () => {
    await withRegisteredService({ kind: "status", status: 500 }, "0.0.0-old", async () => {
      const started = await runDaemon((daemon) => daemon.start())
      expect(started.ok).toBe(false)
      if (!started.ok) expect(started.message).toContain("Could not confirm")
    })
  }, 60_000)

  test("verified idle zero, version mismatch: start replaces (old process killed, new spawn attempted)", async () => {
    const originalArgv1 = process.argv[1]
    const originalMark = process.env.ALPHACODE_TEST_MARK
    process.env.ALPHACODE_TEST_MARK = markerOut
    process.argv[1] = markerScript
    rmSync(markerOut, { force: true })
    const server = fakeServer({ kind: "ok", runs: 0 })
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    writeRegistration({ version: "0.0.0-old", url: server.url.origin, pid: child.pid })
    try {
      const started = await runDaemon((daemon) => daemon.start())
      expect(started.ok).toBe(false)
      if (!started.ok) expect(started.message).toContain("Failed to start server")
      expect(await child.exited).not.toBe(null)
      expect(alive(child.pid)).toBe(false)
      expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
      process.argv[1] = originalArgv1
      if (originalMark === undefined) delete process.env.ALPHACODE_TEST_MARK
      else process.env.ALPHACODE_TEST_MARK = originalMark
    }
  }, 60_000)

  test("verified idle zero, version mismatch: restart stops the old process and spawns a new one", async () => {
    const originalArgv1 = process.argv[1]
    const originalMark = process.env.ALPHACODE_TEST_MARK
    process.env.ALPHACODE_TEST_MARK = markerOut
    process.argv[1] = markerScript
    rmSync(markerOut, { force: true })
    const server = fakeServer({ kind: "ok", runs: 0 })
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    writeRegistration({ version: "0.0.0-old", url: server.url.origin, pid: child.pid })
    try {
      const restarted = await runDaemon((daemon) => daemon.restart())
      expect(restarted.ok).toBe(false)
      if (!restarted.ok) expect(restarted.message).toContain("Failed to start server")
      expect(await child.exited).not.toBe(null)
      expect(readFileSync(markerOut, "utf8")).toBe("serve --register")
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
      process.argv[1] = originalArgv1
      if (originalMark === undefined) delete process.env.ALPHACODE_TEST_MARK
      else process.env.ALPHACODE_TEST_MARK = originalMark
    }
  }, 60_000)

  test("explicit service stop is unchanged: ends the process even with an active run", async () => {
    const server = fakeServer({ kind: "ok", runs: 1 })
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
    writeRegistration({ version: installationVersion, url: server.url.origin, pid: child.pid })
    try {
      await runDaemon((daemon) => daemon.stop())
      expect(await child.exited).not.toBe(null)
      expect(alive(child.pid)).toBe(false)
      expect(existsSync(serverFile)).toBe(false)
    } finally {
      child.kill()
      server.stop(true)
      rmSync(serverFile, { force: true })
    }
  }, 60_000)
})
