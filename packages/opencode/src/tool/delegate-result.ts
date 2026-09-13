import { SessionV1 } from "@opencode-ai/core/v1/session"
import { parsePatch } from "../patch"
import path from "path"

export interface TestOutcome {
  command: string
  status: "passed" | "failed"
  exitCode: number | null
}

/** Machine-readable result of one delegation, returned to the calling agent. */
export interface DelegationResult {
  status: "completed" | "error" | "timeout" | "cancelled"
  summary: string
  /**
   * Files the child's file-editing tools (write/edit/apply_patch) touched,
   * resolved against the child's cwd. This is an observation of those tool
   * calls, not an exhaustive workspace diff: mutations made through the shell
   * (`rm`, `mv`, `sed -i`, `git checkout --`) or MCP tools do not appear, so
   * an empty list is not a guarantee that nothing changed.
   */
  observedFiles: string[]
  tests: TestOutcome[]
  warnings: string[]
}

const TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b/

/**
 * Derives the machine-readable delegation result from the child session's
 * transcript. `observedFiles` and test outcomes are observed facts from the
 * child's file-editing and test tool calls — not self-reports, and not an
 * exhaustive workspace diff (mutations via the shell or MCP do not appear);
 * the summary and extra warnings come from the child's `finish` result when
 * it is valid JSON. Relative tool paths are resolved against the child's
 * working directory, not the process cwd.
 */
export function deriveDelegationResult(input: {
  messages: SessionV1.WithParts[]
  status: DelegationResult["status"]
  failure?: string
  cwd: string
}): DelegationResult {
  const observedFiles: string[] = []
  const tests: TestOutcome[] = []
  const warnings: string[] = []
  let summary = ""
  let reportedWarnings: string[] = []

  const addFile = (file: string | undefined) => {
    if (!file) return
    const resolved = path.isAbsolute(file) ? file : path.resolve(input.cwd, file)
    if (!observedFiles.includes(resolved)) observedFiles.push(resolved)
  }

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
        warnings.push(`${part.tool} failed: ${part.state.error.slice(0, 160)}`)
        continue
      }
      if (part.state.status !== "completed") continue
      const callInput = part.state.input
      if (part.tool === "write" || part.tool === "edit") addFile(callInput.filePath as string | undefined)
      if (part.tool === "apply_patch" && typeof callInput.patchText === "string") {
        for (const hunk of parsePatch(callInput.patchText).hunks) {
          addFile(hunk.path)
          if (hunk.type === "update") addFile(hunk.move_path)
        }
      }
      if (part.tool === "bash" && typeof callInput.command === "string" && TEST_COMMAND.test(callInput.command)) {
        const exitCode = typeof part.state.metadata?.exit === "number" ? part.state.metadata.exit : null
        tests.push({
          command: callInput.command,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
        })
      }
      if (part.tool === "finish" && typeof callInput.result === "string") {
        const reported = parseFinishResult(callInput.result)
        summary = reported.summary
        reportedWarnings = reported.warnings
      }
    }
  }

  warnings.push(...reportedWarnings)
  if (input.failure) warnings.push(input.failure.slice(0, 300))
  if (!summary) summary = input.status === "completed" ? "Delegation finished without a final report." : (input.failure ?? "")

  return {
    status: input.status,
    summary,
    observedFiles,
    tests,
    warnings: warnings.slice(0, 10),
  }
}

function parseFinishResult(text: string): { summary: string; warnings: string[] } {
  try {
    const value = JSON.parse(text) as { summary?: unknown; warnings?: unknown }
    const summary = typeof value.summary === "string" ? value.summary : ""
    const warnings = Array.isArray(value.warnings) ? value.warnings.filter((w): w is string => typeof w === "string") : []
    if (!summary && warnings.length === 0) throw new Error("empty")
    return { summary, warnings }
  } catch {
    return { summary: text, warnings: [] }
  }
}

export * as DelegateResult from "./delegate-result"
