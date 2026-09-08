import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { sharedBrowser } from "@/provider/qwen-web/browser"
import { QwenWebAuthPlugin } from "@/provider/qwen-web/plugin"

describe("QwenWebAuthPlugin", () => {
  test("registers browser-based oauth login", async () => {
    const hooks = await QwenWebAuthPlugin({} as PluginInput)
    expect(hooks.auth?.provider).toBe("qwen-web")
    const methods = hooks.auth?.methods ?? []
    expect(methods).toHaveLength(1)
    const method = methods[0]!
    expect(method.type).toBe("oauth")
    if (method.type !== "oauth") throw new Error("unreachable")
    expect(method.label).toMatch(/qwen/i)
    const authorization = await method.authorize()
    expect(authorization.url).toBe("https://chat.qwen.ai/auth")
    expect(authorization.instructions.length).toBeGreaterThan(20)
    expect(authorization.method).toBe("auto")
    expect(typeof authorization.callback).toBe("function")
  })

  test("provider hook serves models without launching a browser", async () => {
    expect(sharedBrowser().isRunning()).toBe(false)
    const hooks = await QwenWebAuthPlugin({} as PluginInput)
    expect(hooks.provider?.id).toBe("qwen-web")
    const models = await hooks.provider!.models!({} as never, {})
    expect(Object.keys(models).length).toBeGreaterThan(0)
    for (const model of Object.values(models)) {
      expect(model.api.npm).toBe("qwen-web")
    }
    expect(sharedBrowser().isRunning()).toBe(false)
  })

  test("dispose shuts down cleanly when idle", async () => {
    const hooks = await QwenWebAuthPlugin({} as PluginInput)
    await expect(hooks.dispose!()).resolves.toBeUndefined()
  })
})
