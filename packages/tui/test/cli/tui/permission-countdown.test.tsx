/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { Countdown } from "../../../src/routes/session/permission"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for the countdown to mount")
    await Bun.sleep(10)
  }
}

async function mountCountdown(root: string, expiresAt: number) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const config = createTuiResolvedConfig({})
  let mounted = false

  function Harness() {
    onMount(() => {
      mounted = true
    })
    return <Countdown expiresAt={expiresAt} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Harness />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 3 },
  )

  // KVProvider renders its children only once KV state has loaded, so the countdown is
  // not in the tree until the harness reports it mounted.
  await wait(() => mounted)
  await app.renderOnce()
  return app
}

test("permission countdown renders the time left before the prompt is auto-denied", async () => {
  await using tmp = await tmpdir()
  const app = await mountCountdown(tmp.path, Date.now() + 42_000)
  try {
    expect(app.captureCharFrame()).toContain("auto-deny in 42s")
  } finally {
    app.renderer.destroy()
  }
})

test("permission countdown stops at zero once the deadline has passed", async () => {
  await using tmp = await tmpdir()
  // The server settles the request at the deadline, but until the replied event reaches
  // the client the prompt is still on screen, so the label clamps instead of going
  // negative.
  const app = await mountCountdown(tmp.path, Date.now() - 5_000)
  try {
    expect(app.captureCharFrame()).toContain("auto-deny in 0s")
  } finally {
    app.renderer.destroy()
  }
})
