import { afterEach, expect, test } from "bun:test"
import {
  hasDisplay,
  QwenWebBrowser,
  type QwenWebContext,
  type QwenWebPage,
} from "@opencode-ai/webchat/adapters/qwen/browser"

const savedEnv = { ...process.env }

afterEach(() => {
  process.env = { ...savedEnv }
})

function fakePage(): QwenWebPage {
  return {
    url: () => "https://chat.qwen.ai/",
    isClosed: () => false,
    goto: async () => {},
    evaluate: async () => undefined,
    exposeBinding: async () => {},
    title: async () => "",
    context: () => fakeContext([]),
    on: () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  }
}

function fakeContext(pages: QwenWebPage[]): QwenWebContext {
  return {
    pages: () => pages,
    newPage: async () => {
      const page = fakePage()
      pages.push(page)
      return page
    },
    cookies: async () => [],
    close: async () => {},
    on: () => {},
  }
}

test.skipIf(!hasDisplay())("challenge reveal does not reuse an incompatible in-flight headless launch", async () => {
  delete process.env["QWEN_WEB_HEADLESS"]
  const launchedHeadless: boolean[] = []
  let releaseInitialLaunch!: () => void
  const initialLaunchGate = new Promise<void>((resolve) => {
    releaseInitialLaunch = resolve
  })
  let launches = 0

  const browser = new QwenWebBrowser({
    headless: true,
    launcher: async (_profileDir, options) => {
      launchedHeadless.push(options.headless)
      launches++
      if (launches === 1) await initialLaunchGate
      return fakeContext([fakePage()])
    },
  })

  const initialEnsure = browser.ensure()
  await Promise.resolve()
  const reveal = browser.revealForChallenge()
  releaseInitialLaunch()

  await initialEnsure
  await expect(reveal).resolves.toBe(true)
  expect(launchedHeadless).toEqual([true, false])
  await browser.close()
})
