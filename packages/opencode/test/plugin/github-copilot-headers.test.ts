import { describe, expect, test } from "bun:test"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

// `chat.headers` decides whether Copilot sees a turn as agent-initiated. Auto-compaction resumes a
// turn with a user message whose only part is the `compaction_continue` marker, so a marker part
// must mark the request agent-initiated while a genuine user prompt must not. No auth flow is
// needed: the hook only reads the message through the injected client.
function plugin(parts: Array<Record<string, unknown>>, session: { parentID?: string } = {}) {
  const requested: string[] = []
  return CopilotAuthPlugin({
    client: {
      session: {
        message: () => {
          requested.push("message")
          return Promise.resolve({ data: { parts } })
        },
        get: () => {
          requested.push("get")
          return Promise.resolve({ data: { ...session } })
        },
      },
    },
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  } as never).then((hooks) => ({ hooks, requested }))
}

const headers = (parts: Array<Record<string, unknown>>, session?: { parentID?: string }) =>
  plugin(parts, session).then(async ({ hooks, requested }) => {
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(
      {
        sessionID: "ses_1",
        agent: "work",
        message: { id: "msg_1", sessionID: "ses_1" },
        model: { providerID: "github-copilot", api: { id: "gpt-5", npm: "@ai-sdk/openai-compatible" } },
      } as never,
      output,
    )
    return { headers: output.headers, requested }
  })

describe("github-copilot chat.headers", () => {
  test("marks a compaction_continue marker as agent-initiated", async () => {
    const result = await headers([
      {
        type: "text",
        text: "Continue if you have next steps",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ])

    expect(result.headers["x-initiator"]).toBe("agent")
    // A continuation is agent-initiated on its own merit, with no session lookup needed.
    expect(result.requested).toEqual(["message"])
  })

  test("marks a compaction part as agent-initiated", async () => {
    const result = await headers([{ type: "compaction", auto: true }])

    expect(result.headers["x-initiator"]).toBe("agent")
  })

  test("leaves a user prompt unmarked, and still marks subagent sessions", async () => {
    const manual = await headers([{ type: "text", text: "keep going" }])
    expect(manual.headers["x-initiator"]).toBeUndefined()

    const subagent = await headers([{ type: "text", text: "keep going" }], { parentID: "ses_parent" })
    expect(subagent.headers["x-initiator"]).toBe("agent")
  })

  test("does not treat legitimate synthetic text as agent-initiated", async () => {
    // MCP resource reads and background-task notices are synthetic but are real conversation.
    const result = await headers([{ type: "text", text: "server://docs/readme.md", synthetic: true }])

    expect(result.headers["x-initiator"]).toBeUndefined()
  })

  test("marks a compaction part as agent-initiated", async () => {
    const result = await headers([{ type: "compaction", auto: true }])
    expect(result.headers["x-initiator"]).toBe("agent")
  })

  test("ignores a non-copilot model", async () => {
    const output = { headers: {} as Record<string, string> }
    const { hooks, requested } = await plugin([{ type: "compaction", auto: true }])
    await hooks["chat.headers"]!(
      {
        sessionID: "ses_1",
        agent: "work",
        message: { id: "msg_1", sessionID: "ses_1" },
        model: { providerID: "anthropic", api: { id: "claude", npm: "@ai-sdk/anthropic" } },
      } as never,
      output,
    )
    expect(output.headers["x-initiator"]).toBeUndefined()
    expect(requested).toEqual([])
  })
})
