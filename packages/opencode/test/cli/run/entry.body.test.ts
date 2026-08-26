import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { entryBody, entryCanStream, entryDone } from "@/cli/cmd/run/entry.body"
import { entryCancelled, entryFailed } from "@/cli/cmd/run/scrollback.shared"
import { toolInlineInfo, toolView } from "@/cli/cmd/run/tool"
import type { StreamCommit, ToolSnapshot } from "@/cli/cmd/run/types"

function commit(input: Partial<StreamCommit> & Pick<StreamCommit, "kind" | "text" | "phase" | "source">): StreamCommit {
  return input
}

function toolPart(tool: string, state: ToolPart["state"], id = `${tool}-1`, messageID = `msg-${tool}`): ToolPart {
  return {
    id,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: `call-${id}`,
    tool,
    state,
  } as ToolPart
}

function toolCommit(input: {
  tool: string
  state: ToolPart["state"]
  phase?: StreamCommit["phase"]
  toolState?: StreamCommit["toolState"]
  text?: string
  id?: string
  messageID?: string
}) {
  return commit({
    kind: "tool",
    text: input.text ?? "",
    phase: input.phase ?? "final",
    source: "tool",
    tool: input.tool,
    toolState: input.toolState ?? "completed",
    part: toolPart(input.tool, input.state, input.id, input.messageID),
  })
}

function structured(next: StreamCommit) {
  const body = entryBody(next)
  expect(body.type).toBe("structured")
  if (body.type !== "structured") {
    throw new Error("expected structured body")
  }

  return body.snapshot
}

describe("run entry body", () => {
  test("renders assistant, reasoning, and user entries in their display formats", () => {
    expect(
      entryBody(
        commit({
          kind: "assistant",
          text: "# Title\n\nHello **world**",
          phase: "progress",
          source: "assistant",
          partID: "part-1",
        }),
      ),
    ).toEqual({
      type: "markdown",
      content: "# Title\n\nHello **world**",
    })

    const reasoning = entryBody(
      commit({
        kind: "reasoning",
        text: "Thinking: plan next steps",
        phase: "progress",
        source: "reasoning",
        partID: "reason-1",
      }),
    )
    expect(reasoning).toEqual({
      type: "code",
      filetype: "markdown",
      content: "_Thinking:_ plan next steps",
    })
    expect(
      entryCanStream(
        commit({
          kind: "reasoning",
          text: "Thinking: plan next steps",
          phase: "progress",
          source: "reasoning",
        }),
        reasoning,
      ),
    ).toBe(true)

    expect(
      entryBody(
        commit({
          kind: "user",
          text: "Inspect footer tabs",
          phase: "start",
          source: "system",
        }),
      ),
    ).toEqual({
      type: "text",
      content: "› Inspect footer tabs",
    })
  })

  for (const item of [
    {
      name: "keeps completed write tool finals structured",
      commit: toolCommit({
        tool: "write",
        state: {
          status: "completed",
          input: {
            filePath: "src/a.ts",
            content: "const x = 1\n",
          },
          output: "",
          title: "",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "code",
        title: "# Wrote src/a.ts",
        content: "const x = 1\n",
        file: "src/a.ts",
      },
    },
    {
      name: "keeps completed edit tool finals structured",
      commit: toolCommit({
        tool: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "src/a.ts",
          },
          output: "",
          title: "",
          metadata: {
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "diff",
        items: [
          {
            title: "# Edited src/a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            file: "src/a.ts",
          },
        ],
      },
    },
    {
      name: "keeps completed apply_patch tool finals structured",
      commit: toolCommit({
        tool: "apply_patch",
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: {
            files: [
              {
                type: "update",
                filePath: "src/a.ts",
                relativePath: "src/a.ts",
                patch: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          },
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "diff",
        items: [
          {
            title: "# Patched src/a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            file: "src/a.ts",
            deletions: 0,
          },
        ],
      },
    },
  ] satisfies Array<{ name: string; commit: StreamCommit; snapshot: ToolSnapshot }>) {
    test(item.name, () => {
      expect(structured(item.commit)).toEqual(item.snapshot)
    })
  }

  test("keeps running task tool state out of scrollback", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "task",
          phase: "start",
          toolState: "running",
          text: "running inspect reducer",
          state: {
            status: "running",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            time: { start: 1 },
          },
        }),
      ),
    ).toEqual({
      type: "none",
    })
  })

  test("promotes task results to markdown and falls back to structured task summaries", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            title: "",
            output: [
              '<task id="child-1" state="completed">',
              "<task_result>",
              "# Findings\n\n- Footer stays live",
              "</task_result>",
              "</task>",
            ].join("\n"),
            metadata: {
              sessionId: "child-1",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "markdown",
      content: "# Findings\n\n- Footer stays live",
    })

    expect(
      structured(
        toolCommit({
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            title: "",
            output: ['<task id="child-1" state="completed">', "<task_result>", "", "</task_result>", "</task>"].join(
              "\n",
            ),
            metadata: {
              sessionId: "child-1",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      kind: "task",
      title: "# Explore Task",
      rows: ["Inspect reducer"],
      tail: "",
    })
  })

  test("streams tool progress text and treats completed progress as done", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "partial output",
        phase: "progress",
        source: "tool",
        tool: "bash",
        partID: "tool-2",
      }),
    )

    expect(body).toEqual({
      type: "text",
      content: "partial output",
    })
    expect(
      entryCanStream(
        commit({
          kind: "tool",
          text: "partial output",
          phase: "progress",
          source: "tool",
          tool: "bash",
        }),
        body,
      ),
    ).toBe(true)
    expect(
      entryDone(
        commit({
          kind: "tool",
          text: "output",
          phase: "progress",
          source: "tool",
          tool: "bash",
          toolState: "completed",
        }),
      ),
    ).toBe(true)
  })

  test("formats completed bash output with a blank line after the command and no trailing blank row", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "bash",
          phase: "progress",
          toolState: "completed",
          text: ["/tmp/demo", "git status", "On branch demo", "nothing to commit, working tree clean", ""].join("\n"),
          state: {
            status: "completed",
            input: {
              command: "git status",
              workdir: "/tmp/demo",
            },
            output: ["/tmp/demo", "git status", "On branch demo", "nothing to commit, working tree clean", ""].join(
              "\n",
            ),
            title: "git status",
            metadata: {
              exitCode: 0,
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "\nOn branch demo\nnothing to commit, working tree clean",
    })
  })

  test("renders command-only bash starts without the shell header", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "bash",
          phase: "start",
          toolState: "running",
          text: "running shell",
          state: {
            status: "running",
            input: {
              command: "ls",
            },
            time: { start: 1 },
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "$ ls",
    })
  })

  test("renders direct shell commits without a synthetic shell header", () => {
    expect(
      entryBody(
        commit({
          kind: "tool",
          text: "running shell",
          phase: "start",
          source: "tool",
          tool: "bash",
          partID: "shell:call-1",
          toolState: "running",
          shell: {
            callID: "call-1",
            command: "pwd",
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "$ pwd",
    })

    expect(
      entryBody(
        commit({
          kind: "tool",
          text: "/tmp/demo\n",
          phase: "progress",
          source: "tool",
          tool: "bash",
          partID: "shell:call-1",
          toolState: "completed",
          shell: {
            callID: "call-1",
            command: "pwd",
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "\n/tmp/demo",
    })
  })

  test("falls back to patch summary when apply_patch has no visible diff items", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {
              patchText: "*** Begin Patch\n*** End Patch",
            },
            output: "",
            title: "",
            metadata: {
              files: [
                {
                  type: "update",
                  filePath: "src/a.ts",
                  relativePath: "src/a.ts",
                  diff: "@@ -1 +1 @@\n-old\n+new\n",
                },
              ],
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "~ Patched src/a.ts",
    })
  })

  test("suppresses redundant patched rows when apply_patch also created a file", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {
              patchText: "*** Begin Patch\n*** End Patch",
            },
            output: "",
            title: "",
            metadata: {
              files: [
                {
                  type: "update",
                  filePath: "src/a.ts",
                  relativePath: "src/a.ts",
                  diff: "@@ -1 +1 @@\n-old\n+new\n",
                },
                {
                  type: "add",
                  filePath: "README-demo.md",
                  relativePath: "README-demo.md",
                },
              ],
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "+ Created README-demo.md",
    })
  })

  test("renders glob failures as the raw error under the existing header", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "glob",
          phase: "final",
          toolState: "error",
          state: {
            status: "error",
            input: {
              pattern: "**/*tool*",
              path: "/tmp/demo/run",
            },
            error: "No such file or directory: '/tmp/demo/run'",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "text",
      content: "No such file or directory: '/tmp/demo/run'",
    })
  })

  test("registers every AlphaCode-native tool in direct-mode display rules", () => {
    const fallback = { output: true, final: true }
    const builtins = [
      "invalid",
      "attachment",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "bash",
      "read",
      "glob",
      "grep",
      "edit",
      "write",
      "task",
      "webfetch",
      "todowrite",
      "websearch",
      "skill",
      "apply_patch",
      "question",
      "tool_search",
      "tool_search_regex",
      "finish",
      "execute",
      "lsp",
      "plan_exit",
    ]
    for (const tool of builtins) expect(toolView(tool)).not.toEqual(fallback)
    expect(toolView("attachment")).toEqual({ output: false, final: true })
    expect(toolView("plugin_tool")).toEqual(fallback)
  })

  test("formats native attachment, tool-search, execute, and finish summaries", () => {
    const attachment = toolInlineInfo(
      toolPart("attachment", {
        status: "completed",
        input: { action: "list" },
        output: "private raw output",
        title: "attachment",
        metadata: {
          action: "list",
          attachments: [
            { managed_id: "private-id", name: "design.png", mime: "image/png", source: "/private/source" },
            { managed_id: "private-id-2", name: "notes.txt", mime: "text/plain", source: "/private/notes" },
          ],
        },
        time: { start: 1, end: 2 },
      }),
    )
    expect(attachment).toEqual({
      icon: "@",
      title: "Listed 2 attachments",
      mode: "block",
      body: "↳ design.png · image/png\n↳ notes.txt · text/plain",
    })
    expect(attachment.body).not.toContain("private-id")
    expect(attachment.body).not.toContain("/private/source")

    expect(
      toolInlineInfo(
        toolPart("list_mcp_resources", {
          status: "completed",
          input: { server: "docs" },
          output: '{"resources":[]}',
          title: "MCP resources: docs",
          metadata: { server: "docs", count: 0, servers: ["docs"] },
          time: { start: 1, end: 2 },
        }),
      ),
    ).toEqual({ icon: "✱", title: "MCP resources from docs (0 found)" })

    expect(
      toolInlineInfo(
        toolPart("tool_search_regex", {
          status: "completed",
          input: { pattern: "[" },
          output: "Invalid regex pattern",
          title: "Invalid regex",
          metadata: { query: "[", count: 0, tools: [] },
          time: { start: 1, end: 2 },
        }),
      ),
    ).toEqual({ icon: "?", title: "Tool search /[/ (invalid regex)" })

    expect(
      toolInlineInfo(
        toolPart("execute", {
          status: "completed",
          input: { code: "tools.read({ filePath: 'a.ts' })" },
          output: "MCP request failed",
          title: "execute",
          metadata: { error: true, toolCalls: [{ tool: "mcp_lookup", status: "error", input: { query: "alpha" } }] },
          time: { start: 1, end: 2 },
        }),
      ),
    ).toEqual({
      icon: "✗",
      title: "execute",
      mode: "block",
      body: "↳ mcp_lookup [query=alpha] (failed)\n  MCP request failed",
    })

    const fallback = toolInlineInfo(
      toolPart("plugin_tool", {
        status: "completed",
        input: { query: "x".repeat(500), internal: { token: "do-not-render" } },
        output: "done",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    )
    expect(fallback.icon).toBe("⚙")
    expect(fallback.title.length).toBeLessThanOrEqual(212)
    expect(fallback.title).not.toContain("do-not-render")

    expect(
      toolInlineInfo(
        toolPart("finish", {
          status: "completed",
          input: { result: "Verified the native renderers." },
          output: "Verified the native renderers.",
          title: "Task completed",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
      ),
    ).toEqual({
      icon: "✓",
      title: "Task completed",
      mode: "block",
      body: "Verified the native renderers.",
    })
  })

  test("renders semantic failures and cancellations with native status language", () => {
    const runtimeFailure = toolCommit({
      tool: "execute",
      state: {
        status: "completed",
        input: { code: "tools.fail()" },
        output: "Runtime failed",
        title: "execute",
        metadata: { error: true, toolCalls: [] },
        time: { start: 1, end: 2 },
      },
    })
    expect(entryFailed(runtimeFailure)).toBe(true)
    expect(entryBody(runtimeFailure)).toEqual({ type: "text", content: "✗ execute\n  Runtime failed" })

    const interrupted = toolCommit({
      tool: "read",
      phase: "final",
      toolState: "error",
      state: {
        status: "error",
        input: { filePath: "src/a.ts" },
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })
    expect(entryCancelled(interrupted)).toBe(true)
    expect(entryFailed(interrupted)).toBe(false)
    expect(entryBody(interrupted)).toEqual({ type: "text", content: "~ read interrupted" })

    const denied = toolCommit({
      tool: "webfetch",
      phase: "final",
      toolState: "error",
      state: {
        status: "error",
        input: { url: "https://example.com" },
        error: "The user rejected permission to use this tool",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    expect(entryCancelled(denied)).toBe(true)
    expect(entryBody(denied)).toEqual({ type: "text", content: "~ webfetch cancelled" })
  })

  test("renders interrupted assistant finals as text", () => {
    expect(
      entryBody(
        commit({
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          interrupted: true,
          partID: "part-1",
        }),
      ),
    ).toEqual({
      type: "text",
      content: "assistant interrupted",
    })
  })
})
