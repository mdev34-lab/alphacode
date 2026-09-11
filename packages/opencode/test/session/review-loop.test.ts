import { expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ReviewLoop } from "../../src/session/review-loop"

const msg = (role: "user" | "assistant", parts: Array<Record<string, unknown>> = []) =>
  ({ info: { role }, parts: parts.map((part, i) => ({ id: `p${i}`, ...part })) }) as unknown as SessionV1.WithParts

const tool = (name: string, state: Record<string, unknown>) => ({ type: "tool", tool: name, callID: name, state })
const completed = (input: Record<string, unknown> = {}, output = "") => ({
  status: "completed",
  input,
  output,
  title: "",
  metadata: {},
  time: { start: 0, end: 1 },
})

const writePart = () => tool("write", completed({ filePath: "src/a.ts" }))
const bashPart = (command: string) => tool("bash", completed({ command }))
const reviewPart = (output: string) => tool("task", completed({ subagent_type: "review" }, output))
const reviewRunningPart = () => tool("task", { status: "running", input: { subagent_type: "review" }, output: "" })
const reviewNudge = () => ({ type: "text", synthetic: true, text: `${ReviewLoop.NUDGE_MARKER} blocked` })

const approvedReport = [
  "#### Critical",
  "- None",
  "",
  "#### Important (Should Fix)",
  "- None found",
  "",
  "### Assessment",
  "**Ready to proceed?** Approved",
].join("\n")

const contradictoryApproval = [
  "#### Important (Should Fix)",
  "- src/a.ts: missing null check",
  "",
  "### Assessment",
  "**Ready to proceed?** Approved",
].join("\n")

const findingsA = [
  "#### Important (Should Fix)",
  "- src/a.ts: missing null check",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
].join("\n")

const findingsB = [
  "#### Important (Should Fix)",
  "- src/b.ts: retry policy is incorrect",
  "",
  "### Assessment",
  "**Ready to proceed?** Needs fixes",
].join("\n")

test("approval requires an explicit clean review report", () => {
  expect(ReviewLoop.parseVerdict(approvedReport)).toBe("approved")
  expect(ReviewLoop.parseVerdict(contradictoryApproval)).toBe("unknown")
  expect(ReviewLoop.parseVerdict("**Ready to proceed?** Approved")).toBe("unknown")
  expect(ReviewLoop.parseVerdict("The owner approved the plan")).toBe("unknown")
})

test("max_iterations counts review passes, never reminder nudges", () => {
  const messages = [msg("user", [{ type: "text", text: "work" }]), msg("assistant", [writePart()])]
  const blocked = ReviewLoop.decide(messages, { cap: 2, nudges: 2 })
  expect(blocked.blocked).toBe(true)
  expect(blocked.exitReason).toBeUndefined()

  const reviewed = [...messages, msg("user", [reviewNudge()]), msg("assistant", [reviewPart(findingsA)])]
  const capped = ReviewLoop.decide(reviewed, { cap: 1, nudges: 1 })
  expect(capped.blocked).toBe(false)
  expect(capped.exitReason).toBe("cap")
})

test("unresponsive guard counts consecutive reminders without progress", () => {
  const messages: SessionV1.WithParts[] = [msg("user", [{ type: "text", text: "work" }]), msg("assistant", [writePart()])]
  for (let i = 0; i < ReviewLoop.UNRESPONSIVE_NUDGE_LIMIT; i++) {
    messages.push(msg("user", [reviewNudge()]))
  }
  const released = ReviewLoop.decide(messages, { nudges: ReviewLoop.UNRESPONSIVE_NUDGE_LIMIT })
  expect(released.exitReason).toBe("unresponsive")

  const progressing: SessionV1.WithParts[] = [msg("user", [{ type: "text", text: "work" }]), msg("assistant", [writePart()])]
  for (let i = 0; i < ReviewLoop.UNRESPONSIVE_NUDGE_LIMIT + 2; i++) {
    progressing.push(msg("user", [reviewNudge()]))
    progressing.push(msg("assistant", [writePart()]))
  }
  const active = ReviewLoop.decide(progressing, { nudges: ReviewLoop.UNRESPONSIVE_NUDGE_LIMIT + 2 })
  expect(active.blocked).toBe(true)
  expect(active.exitReason).toBeUndefined()
})

test("shell mutation detection catches writes without gating ordinary inspection", () => {
  const readOnly = [
    msg("user", [{ type: "text", text: "inspect" }]),
    msg("assistant", [bashPart("git diff --stat && git status")]),
  ]
  expect(ReviewLoop.assess(readOnly).filesChanged).toBe(false)

  const redirected = [
    msg("user", [{ type: "text", text: "edit" }]),
    msg("assistant", [bashPart("echo fixed > src/a.ts")]),
  ]
  const pythonWrite = [
    msg("user", [{ type: "text", text: "edit" }]),
    msg("assistant", [bashPart("python -c \"open('src/a.ts', 'w').write('fixed')\"")]),
  ]
  expect(ReviewLoop.assess(redirected).filesChanged).toBe(true)
  expect(ReviewLoop.assess(pythonWrite).filesChanged).toBe(true)
  expect(ReviewLoop.shellMayMutate("bun test packages/opencode/test/session/review-loop.test.ts")).toBe(false)
  expect(ReviewLoop.shellMayMutate("sed -i 's/old/new/' src/a.ts")).toBe(true)
  expect(ReviewLoop.shellMayMutate("git commit -am 'save'")).toBe(true)
})

test("approval is invalidated by a later mutation", () => {
  const approved = [
    msg("user", [{ type: "text", text: "work" }]),
    msg("assistant", [writePart(), reviewPart(approvedReport)]),
  ]
  expect(ReviewLoop.decide(approved, { nudges: 0 }).exitReason).toBe("approved")

  const changed = [...approved, msg("assistant", [writePart()])]
  const decision = ReviewLoop.decide(changed, { nudges: 0 })
  expect(decision.blocked).toBe(true)
  expect(decision.exitReason).toBeUndefined()
})

test("stall detection only releases repeated identical blocking findings", () => {
  const repeated: SessionV1.WithParts[] = [
    msg("user", [{ type: "text", text: "work" }]),
    msg("assistant", [writePart(), reviewPart(findingsA)]),
    msg("assistant", [reviewPart(findingsA)]),
    msg("assistant", [reviewPart(findingsA)]),
  ]
  const stalled = ReviewLoop.decide(repeated, { nudges: 0 })
  expect(stalled.stalled).toBe(true)
  expect(stalled.exitReason).toBe("stalled")

  const changedFindings: SessionV1.WithParts[] = [
    msg("user", [{ type: "text", text: "work" }]),
    msg("assistant", [writePart(), reviewPart(findingsA)]),
    msg("assistant", [reviewPart(findingsB)]),
    msg("assistant", [reviewPart(findingsA)]),
  ]
  const productive = ReviewLoop.decide(changedFindings, { nudges: 3 })
  expect(productive.blocked).toBe(true)
  expect(productive.exitReason).toBeUndefined()
})

test("running review is visible as the review phase", () => {
  const messages = [msg("user", [{ type: "text", text: "work" }]), msg("assistant", [writePart(), reviewRunningPart()])]
  const decision = ReviewLoop.decide(messages, { nudges: 0 })
  expect(decision.inLoop).toBe(true)
  expect(decision.phase).toBe("review")
})

test("synthetic review nudges do not reset the current task slice", () => {
  const messages = [
    msg("user", [{ type: "text", text: "work" }]),
    msg("assistant", [writePart()]),
    msg("user", [reviewNudge()]),
  ]
  const state = ReviewLoop.assess(messages)
  expect(state.filesChanged).toBe(true)
  expect(state.dirty).toBe(true)
  expect(ReviewLoop.taskSlice(messages)).toHaveLength(2)
})

test("uncapped nudges report no round limit and caps name review passes", () => {
  const messages = [msg("user", [{ type: "text", text: "work" }]), msg("assistant", [writePart()])]
  const uncapped = ReviewLoop.nudgeText(ReviewLoop.decide(messages, { nudges: 1 }))
  expect(uncapped).toContain("no round limit")
  expect(uncapped).not.toContain("configured cap")

  const capped = ReviewLoop.nudgeText(ReviewLoop.decide(messages, { cap: 3, nudges: 1 }))
  expect(capped).toContain("review pass")
  expect(capped).toContain("3 review passes")
})
