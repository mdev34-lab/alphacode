import { QwenWebBrowser as OriginalQwenWebBrowser } from "./browser.impl"
export * from "./browser.impl"

/**
 * Browser facade that serializes a challenge reveal with an in-flight launch.
 * A headed relaunch must never report success by joining the pre-existing
 * headless launch promise.
 */
export class QwenWebBrowser extends OriginalQwenWebBrowser {
  async revealForChallenge(signal?: AbortSignal): Promise<boolean> {
    const state = this as unknown as { launching?: Promise<unknown> }
    const inFlightLaunch = state.launching
    if (inFlightLaunch) {
      await inFlightLaunch.catch(() => {})
      if (state.launching === inFlightLaunch) state.launching = undefined
    }
    return super.revealForChallenge(signal)
  }
}

let shared: QwenWebBrowser | undefined

export function sharedBrowser(): QwenWebBrowser {
  if (!shared) shared = new QwenWebBrowser()
  return shared
}

export function setSharedBrowser(browser: QwenWebBrowser | undefined): void {
  shared = browser
}

export async function closeSharedBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => {})
    shared = undefined
  }
}