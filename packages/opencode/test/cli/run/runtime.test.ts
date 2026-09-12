import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { SessionTurnInput } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, RunPrompt, RunProvider, StreamCommit } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

function interactiveFooter() {
  const prompts = new Set<(prompt: RunPrompt) => void>()
  const closes = new Set<() => void>()
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []
  let closed = false
  let release!: () => void
  const subscribed = new Promise<void>((resolve) => {
    release = resolve
  })

  const notify = () => {
    for (const fn of closes) fn()
  }

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt(fn) {
      prompts.add(fn)
      release()
      return () => {
        prompts.delete(fn)
      }
    },
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
    },
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }

  return {
    api,
    events,
    commits,
    subscribed,
    submit(text: string) {
      for (const fn of [...prompts]) {
        fn({ text, parts: [] })
      }
    },
  }
}

function resumeSdk(messages: SessionMessage[]) {
  const sdk = new OpencodeClient()
  spyOn(sdk.config, "providers").mockImplementation(async () => ok({ providers: [provider], default: {} }))
  spyOn(sdk.session, "messages").mockImplementation(() => ok(messages))
  spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
  spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
  spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
  spyOn(sdk.command, "list").mockImplementation(() => ok([]))
  return sdk
}

async function waitForPatch(events: FooterEvent[], status: string) {
  const end = Date.now() + 1_000
  while (Date.now() < end) {
    if (events.some((event) => event.type === "stream.patch" && event.patch.status === status)) {
      return
    }

    await Bun.sleep(5)
  }

  throw new Error(`timed out waiting for patch: ${status}`)
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "work",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "work",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  test("drives /continue through the transport without a user message", async () => {
    const ui = interactiveFooter()
    const sdk = resumeSdk([
      {
        info: {
          id: "msg-user-1",
          sessionID: "ses-1",
          role: "user",
          time: {
            created: 1,
          },
          agent: "work",
          model: {
            providerID: "openai",
            modelID: "gpt-5",
            variant: undefined,
          },
        },
        parts: [
          {
            id: "part-user-1",
            sessionID: "ses-1",
            messageID: "msg-user-1",
            type: "text",
            text: "hello",
          },
        ],
      } satisfies SessionMessage,
    ])
    const turns: SessionTurnInput[] = []

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "work",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: ui.api,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async (input) => {
              turns.push(input)
              ui.api.close()
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await ui.subscribed
    ui.submit("/continue")
    await task

    expect(turns.length).toBe(1)
    expect(turns[0].resume).toBe(true)
    expect(turns[0].prompt).toEqual({ text: "", parts: [] })
    expect(ui.commits).toEqual([])
    expect(ui.events.some((event) => event.type === "stream.patch" && event.patch.status === "resuming session")).toBe(
      true,
    )
  })

  test("reports nothing to continue for a session without history", async () => {
    const ui = interactiveFooter()
    const sdk = resumeSdk([])
    const turns: SessionTurnInput[] = []

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-new",
        resume: false,
        agent: "work",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: ui.api,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async (input) => {
              turns.push(input)
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await ui.subscribed
    ui.submit("/continue")
    await waitForPatch(ui.events, "nothing to continue")
    ui.api.close()
    await task

    expect(turns).toEqual([])
    expect(ui.commits).toEqual([])
    expect(
      ui.events.some((event) => event.type === "stream.patch" && event.patch.status === "nothing to continue"),
    ).toBe(true)
  })
})
