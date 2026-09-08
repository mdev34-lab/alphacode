import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  defaultProfileDir,
  hasDisplay,
  profileExists,
  QwenWebBrowser,
  quickAuthState,
  readProfileMetadata,
  type QwenWebContext,
  type QwenWebPage,
} from "@/provider/qwen-web/browser"

let tmpdirs: string[] = []
const savedEnv = { ...process.env }

function tmpProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-profile-"))
  tmpdirs.push(dir)
  return dir
}

afterEach(() => {
  process.env = { ...savedEnv }
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpdirs = []
})

function fakePage(overrides: Partial<QwenWebPage> = {}): QwenWebPage & { navigations: string[] } {
  const page = {
    navigations: [] as string[],
    url: () => "https://chat.qwen.ai/",
    isClosed: () => false,
    goto: async (url: string) => {
      page.navigations.push(url)
      return {} as unknown
    },
    evaluate: async () => undefined as unknown,
    exposeBinding: async () => {},
    title: async () => "",
    context: () => ({}) as QwenWebContext,
    on: () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    ...overrides,
  }
  return page as unknown as QwenWebPage & { navigations: string[] }
}

function fakeContext(pages: QwenWebPage[]): QwenWebContext & { closed: boolean; created: number } {
  const context = {
    closed: false,
    created: 0,
    pages: () => pages.filter((page) => !page.isClosed()),
    newPage: async () => {
      context.created++
      const page = fakePage()
      pages.push(page)
      return page
    },
    cookies: async () => [],
    close: async () => {
      context.closed = true
    },
    on: () => {},
  }
  return context as unknown as QwenWebContext & { closed: boolean; created: number }
}

describe("profile directory and metadata", () => {
  test("defaultProfileDir honors the override", () => {
    const dir = tmpProfile()
    process.env["QWEN_WEB_PROFILE_DIR"] = dir
    expect(defaultProfileDir()).toBe(dir)
    expect(profileExists(dir)).toBe(true)
    expect(profileExists(path.join(dir, "missing"))).toBe(false)
  })

  test("default profile lives under the data dir", () => {
    delete process.env["QWEN_WEB_PROFILE_DIR"]
    expect(defaultProfileDir()).toContain(`qwen-web${path.sep}browser-profile`)
  })

  test("metadata round-trips, missing and corrupt read as undefined", () => {
    const dir = tmpProfile()
    expect(readProfileMetadata(dir)).toBeUndefined()
    fs.writeFileSync(path.join(dir, "metadata.json"), "{corrupt", "utf8")
    expect(readProfileMetadata(dir)).toBeUndefined()
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ version: 1, authenticated: true, loginAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    )
    expect(readProfileMetadata(dir)).toMatchObject({ authenticated: true, loginAt: "2026-01-01T00:00:00.000Z" })
  })
})

describe("hasDisplay", () => {
  test("reflects display environment on linux", () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(hasDisplay()).toBe(true)
      return
    }
    delete process.env["DISPLAY"]
    delete process.env["WAYLAND_DISPLAY"]
    delete process.env["MIR_SOCKET"]
    expect(hasDisplay()).toBe(false)
    process.env["DISPLAY"] = ":0"
    expect(hasDisplay()).toBe(true)
  })
})

describe("quickAuthState", () => {
  test("login and challenge urls", async () => {
    expect(await quickAuthState(fakePage({ url: () => "https://chat.qwen.ai/auth" }))).toBe("login")
    expect(await quickAuthState(fakePage({ url: () => "https://chat.qwen.ai/?x=captcha" }))).toBe("challenge")
  })

  test("auth cookies mean authenticated", async () => {
    const page = fakePage()
    page.context = () => ({ cookies: async () => [{ name: "token", value: "abc" }] }) as unknown as QwenWebContext
    expect(await quickAuthState(page)).toBe("authenticated")
    const bare = fakePage()
    bare.context = () => ({ cookies: async () => [{ name: "nothing", value: "x" }] }) as unknown as QwenWebContext
    expect(await quickAuthState(bare)).toBe("unknown")
  })

  test("throwing pages read as unknown", async () => {
    const page = fakePage({
      url: () => {
        throw new Error("dead")
      },
    })
    expect(await quickAuthState(page)).toBe("unknown")
  })
})

describe("QwenWebBrowser lifecycle", () => {
  test("ensure launches once and reuses the context", async () => {
    const dir = tmpProfile()
    const context = fakeContext([fakePage()])
    let launches = 0
    const browser = new QwenWebBrowser({
      profileDir: dir,
      launcher: async () => {
        launches++
        return context
      },
    })
    expect(browser.isRunning()).toBe(false)
    const first = await browser.ensure()
    const second = await browser.ensure()
    expect(launches).toBe(1)
    expect(first.context).toBe(context)
    expect(second.page).toBe(first.page)
    expect(browser.isRunning()).toBe(true)
    await browser.close()
    expect(browser.isRunning()).toBe(false)
    expect(context.closed).toBe(true)
    expect(fs.existsSync(path.join(dir, "alphacode.lock"))).toBe(false)
  })

  test("stale and self-owned locks do not block launch", async () => {
    for (const pid of ["42424242", String(process.pid)]) {
      const dir = tmpProfile()
      fs.writeFileSync(path.join(dir, "alphacode.lock"), pid, "utf8")
      const context = fakeContext([fakePage()])
      const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
      await browser.ensure()
      expect(browser.isRunning()).toBe(true)
      await browser.close()
    }
  })

  test("invalidatePage recreates the page", async () => {
    const dir = tmpProfile()
    const context = fakeContext([])
    const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
    const first = await browser.ensure()
    browser.invalidatePage()
    // Invalidation marks the cached page dead; the underlying page is gone too.
    first.page.isClosed = () => true
    const second = await browser.ensure()
    expect(second.page).not.toBe(first.page)
    expect(context.created).toBe(2)
    await browser.close()
  })

  test("ensureOnOrigin navigates foreign pages home", async () => {
    const dir = tmpProfile()
    const page = fakePage({ url: () => "https://example.com/" }) as QwenWebPage & { navigations: string[] }
    const context = fakeContext([page])
    const browser = new QwenWebBrowser({ profileDir: dir, launcher: async () => context })
    // navigateHome runs on launch; clear it to isolate ensureOnOrigin.
    await browser.ensure()
    page.navigations.length = 0
    await browser.ensureOnOrigin()
    expect(page.navigations).toEqual(["https://chat.qwen.ai"])
    await browser.close()
  })
})

describe("login behavior", () => {
  test("loginHeaded predicts the headed login switch", () => {
    delete process.env["QWEN_WEB_HEADLESS"]
    if (process.platform !== "darwin" && process.platform !== "win32") {
      delete process.env["DISPLAY"]
      delete process.env["WAYLAND_DISPLAY"]
      delete process.env["MIR_SOCKET"]
    }
    const headlessOnly = new QwenWebBrowser({ profileDir: tmpProfile(), headless: true })
    expect(headlessOnly.loginHeaded).toBe(false)
    const headed = new QwenWebBrowser({ profileDir: tmpProfile(), headless: false })
    expect(headed.loginHeaded).toBe(true)

    process.env["DISPLAY"] = ":1"
    const auto = new QwenWebBrowser({ profileDir: tmpProfile() })
    expect(auto.loginHeaded).toBe(true)
  })

  test("openLoginPage flips to headed when a display exists", async () => {
    process.env["DISPLAY"] = ":1"
    delete process.env["QWEN_WEB_HEADLESS"]
    const dir = tmpProfile()
    const page = fakePage({ url: () => "https://chat.qwen.ai/auth" }) as QwenWebPage & { navigations: string[] }
    let launchedHeadless: boolean | undefined
    const browser = new QwenWebBrowser({
      profileDir: dir,
      launcher: async (_profileDir, options) => {
        launchedHeadless = options.headless
        return fakeContext([page])
      },
    })
    await browser.openLoginPage()
    expect(launchedHeadless).toBe(false)
    expect(page.navigations[page.navigations.length - 1]).toBe("https://chat.qwen.ai/auth")
    await browser.close()
  })

  test("openLoginPage skips navigation when already authenticated", async () => {
    const dir = tmpProfile()
    const page = fakePage() as QwenWebPage & { navigations: string[] }
    page.context = () => ({ cookies: async () => [{ name: "session", value: "x" }] }) as unknown as QwenWebContext
    const browser = new QwenWebBrowser({ profileDir: dir, headless: true, launcher: async () => fakeContext([page]) })
    await browser.openLoginPage()
    // One navigation at most (launch home navigation); never to /auth.
    expect(page.navigations).not.toContain("https://chat.qwen.ai/auth")
    await browser.close()
  })
})
