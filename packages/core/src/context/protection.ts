export * as ContextProtection from "./protection"

import { Glob } from "../util/glob"
import type { SessionMessage } from "../session/message"
import type { ContextMessage, ProtectionPolicy, ToolContextPolicy } from "./types"

/**
 * Tools whose recorded output is never reduced. Losing any of these materially changes how the
 * agent reasons about the current task rather than merely re-reading stale information.
 */
export const DEFAULT_TOOLS: readonly string[] = [
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
  "apply_patch",
  "question",
]

/**
 * Tools whose result depends on external state or that change it. Two identical calls are two
 * different observations, so they must never be deduplicated even when their arguments match.
 */
export const STATE_CHANGING_TOOLS: readonly string[] = [
  "bash",
  "write",
  "edit",
  "apply_patch",
  "todowrite",
  "task",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "attachment",
]

/** Canonical message variants that carry runtime state rather than reducible conversation. */
export const DEFAULT_MESSAGE_TYPES: readonly SessionMessage.Message["type"][] = [
  "system",
  "compaction",
  "agent-switched",
  "model-switched",
]

export const defaultPolicy: ProtectionPolicy = {
  tools: DEFAULT_TOOLS,
  filePatterns: [],
  messageTypes: DEFAULT_MESSAGE_TYPES,
  recentTurns: 4,
  userMessages: false,
}

export interface Resolved {
  /** Index of the first message inside the protected recent window. */
  readonly recentFrom: number
  readonly messageIDs: ReadonlySet<SessionMessage.ID>
  readonly callIDs: ReadonlySet<string>
}

/**
 * Resolve every protection rule once for a canonical message list. Each pruning strategy consults
 * the result instead of re-deriving protection from scratch.
 */
export const resolve = (
  messages: readonly ContextMessage[],
  input: { readonly policy: ProtectionPolicy; readonly toolPolicies?: Readonly<Record<string, ToolContextPolicy>> },
): Resolved => {
  const recentFrom = recentWindow(messages, input.policy.recentTurns)
  const messageIDs = new Set<SessionMessage.ID>()
  const callIDs = new Set<string>()
  messages.forEach((message, index) => {
    const recent = index >= recentFrom
    if (recent || input.policy.messageTypes.includes(message.type)) messageIDs.add(message.id)
    if (input.policy.userMessages && (message.type === "user" || message.type === "synthetic"))
      messageIDs.add(message.id)
    if (message.type !== "assistant") return
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (recent) callIDs.add(part.id)
      const protectedCall =
        isProtectedTool(part.name, input.policy, input.toolPolicies) ||
        (input.policy.filePatterns.length > 0 && touchesProtectedFile(part, input.policy.filePatterns))
      if (!protectedCall) continue
      callIDs.add(part.id)
      // A protected call is protected from compression too, not only from output pruning: the
      // message that carries it stays verbatim even when it falls inside a compressed range.
      messageIDs.add(message.id)
    }
  })
  // The newest user message always survives, even when the recent window is configured to zero.
  const latestUser = messages.findLast((message) => message.type === "user" || message.type === "synthetic")
  if (latestUser) messageIDs.add(latestUser.id)
  const latestAssistant = messages.findLast((message) => message.type === "assistant")
  if (latestAssistant) messageIDs.add(latestAssistant.id)
  return { recentFrom, messageIDs, callIDs }
}

export const isProtectedTool = (
  name: string,
  policy: ProtectionPolicy,
  toolPolicies?: Readonly<Record<string, ToolContextPolicy>>,
) => policy.tools.includes(name) || toolPolicies?.[name]?.protect === true

export const isDeduplicable = (
  name: string,
  policy: ProtectionPolicy,
  toolPolicies?: Readonly<Record<string, ToolContextPolicy>>,
) => {
  const declared = toolPolicies?.[name]?.deduplicate
  if (declared !== undefined) return declared
  if (isProtectedTool(name, policy, toolPolicies)) return false
  return !STATE_CHANGING_TOOLS.includes(name)
}

/**
 * Index of the first message belonging to the last `turns` assistant turns. A turn starts at the
 * user message that provoked it, so protection covers the request as well as its response.
 */
export const recentWindow = (messages: readonly ContextMessage[], turns: number) => {
  if (turns <= 0) return messages.length
  let seen = 0
  let boundary = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    boundary = index
    if (messages[index]!.type !== "assistant") continue
    seen++
    if (seen < turns) continue
    // Extend backwards over the user input that started this turn.
    while (boundary > 0 && messages[boundary - 1]!.type !== "assistant") boundary--
    return boundary
  }
  return boundary
}

const PATH_KEYS = ["filePath", "path", "file", "filename", "target", "source"]

export const touchesProtectedFile = (tool: SessionMessage.AssistantTool, patterns: readonly string[]) => {
  const input = tool.state.status === "pending" ? undefined : tool.state.input
  if (!input) return false
  const paths = PATH_KEYS.flatMap((key) => {
    const value = (input as Record<string, unknown>)[key]
    return typeof value === "string" ? [value] : []
  })
  return paths.some((value) => patterns.some((pattern) => Glob.match(pattern, value)))
}
