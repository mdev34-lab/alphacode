import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import type { Level } from "../util/agent-effort"

const ENTRIES: {
  value: Level
  title: string
  description: string
  details: string[]
}[] = [
  {
    value: "fast",
    title: "Fast",
    description: "no review ritual",
    details: ["Inline self-check and syntax/smoke validation, delivered with an honest unreviewed label"],
  },
  {
    value: "medium",
    title: "Medium",
    description: "up to 2 review passes · default",
    details: ["Independent review for code changes; only blocking findings force another pass, then an honest status"],
  },
  {
    value: "thorough",
    title: "Thorough",
    description: "review until clean",
    details: ["Structured review contract with severity-driven convergence and full validation gates, no pass cap"],
  },
]

export function DialogAgentEffort() {
  const local = useLocal()
  const dialog = useDialog()
  const { theme } = useTheme()

  const options = createMemo(() =>
    ENTRIES.map((entry) => ({
      value: entry.value,
      title: entry.title,
      description: entry.description,
      details: entry.details,
      onSelect: () => {
        dialog.clear()
        local.effort.set(entry.value)
      },
    })),
  )

  return (
    <DialogSelect<Level>
      options={options()}
      title="Agent effort"
      current={local.effort.current()}
      flat={true}
      footer={
        <text fg={theme.textMuted}>
          {local.effort.scoped()
            ? "Stored on this session · separate from model thinking"
            : "Config default · open a session to change it"}
        </text>
      }
    />
  )
}
