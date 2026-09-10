/**
 * AlphaCode plugin surface for the Qwen Web provider.
 *
 * - `auth`: browser-based login. AlphaCode opens the Qwen login page in a
 *   persistent Chromium profile; the user logs in normally; the callback
 *   waits for (and persists) the authenticated session. No passwords or
 *   verification codes are ever requested or stored.
 * - `provider`: live model catalog. When the browser is already running with
 *   an authenticated session the models are refreshed from `/api/models`;
 *   otherwise the cached/static catalog is returned. The hook never launches
 *   a browser and never throws.
 * - `dispose`: shuts the shared browser down on server stop.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model as SdkModel } from "@opencode-ai/sdk/v2"
import { QWEN_WEB_AUTH_MARKER, QWEN_WEB_DEFAULTS, QWEN_WEB_PROVIDER_ID } from "@opencode-ai/webchat/adapters/qwen/constants"
import { isNoDisplayError, QwenWebError } from "@opencode-ai/webchat/adapters/qwen/errors"
import { debug } from "@opencode-ai/webchat/adapters/qwen/log"
import { sharedBrowser } from "@opencode-ai/webchat/adapters/qwen/browser"
import { currentModels, refreshModels } from "./catalog"

export async function QwenWebAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: QWEN_WEB_PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Log in with Qwen (opens a browser window)",
          authorize: async () => {
            const headed = sharedBrowser().loginHeaded
            return {
              url: "https://chat.qwen.ai/auth",
              instructions: headed
                ? "A Chromium window opens with the Qwen login page. Log in normally in that window (password, SSO, passkey, or scan — whichever Qwen offers). AlphaCode never sees your credentials; it only detects the completed login. This window closes automatically."
                : "No display was detected, so the login browser runs headless: if this machine already has a Qwen session saved from a previous login it will be reused automatically. Otherwise run `opencode auth login` on a machine with a display first — the saved session is stored under your AlphaCode data directory.",
              method: "auto" as const,
              callback: async () => loginCallback(),
            }
          },
        },
      ],
    },
    provider: {
      id: QWEN_WEB_PROVIDER_ID,
      models: async () => {
        try {
          if (sharedBrowser().isRunning()) {
            try {
              const live = await refreshModels()
              const models = currentModels()
              debug("plugin", `provider hook refreshed ${live.length} live models`)
              return models as unknown as Record<string, SdkModel>
            } catch (error) {
              debug("plugin", "live refresh failed; using cache/fallback", {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          return currentModels() as unknown as Record<string, SdkModel>
        } catch (error) {
          debug("plugin", "models hook failed; using static fallback", {
            error: error instanceof Error ? error.message : String(error),
          })
          return currentModels() as unknown as Record<string, SdkModel>
        }
      },
    },
    dispose: async () => {
      await sharedBrowser()
        .close()
        .catch(() => {})
    },
  }
}

async function loginCallback(): Promise<
  { type: "success"; key: string; metadata?: Record<string, string> } | { type: "failed" }
> {
  const browser = sharedBrowser()
  try {
    await browser.openLoginPage()
  } catch (error) {
    if (error instanceof Error && isNoDisplayError(error)) {
      debug("plugin", "headed login unavailable (no display)")
      return { type: "failed" }
    }
    // Headed launch failed for another reason (missing system deps, sandbox
    // restrictions): fall back to a headless probe so a previously saved
    // session can still authenticate this run.
    debug("plugin", "headed login failed; probing saved session headlessly", {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const state = await browser.detectAuthState()
      if (state === "authenticated") return loginSuccess()
    } catch {
      // Fall through to failure.
    }
    return { type: "failed" }
  }

  // Headless logins cannot be completed interactively: probe once for a
  // previously saved session and fail fast otherwise.
  if (!browser.loginHeaded) {
    const state = await browser.detectAuthState().catch(() => "unknown" as const)
    if (state === "authenticated") return loginSuccess()
    debug("plugin", "headless login without a saved session; failing fast")
    return { type: "failed" }
  }

  try {
    await browser.waitForLogin({ timeoutMs: QWEN_WEB_DEFAULTS.loginTimeoutMs })
    return loginSuccess()
  } catch (error) {
    debug("plugin", "login wait failed", { error: error instanceof Error ? error.message : String(error) })
    return { type: "failed" }
  }
}

function loginSuccess(): { type: "success"; key: string; metadata?: Record<string, string> } {
  debug("plugin", "Qwen login detected; session persisted")
  return {
    type: "success",
    key: QWEN_WEB_AUTH_MARKER,
    metadata: { loginAt: new Date().toISOString() },
  }
}

export function isQwenWebPluginError(error: unknown): error is QwenWebError {
  return QwenWebError.isInstance(error)
}
