import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "@/tool/shell/prompt"

const limits = { maxLines: 100, maxBytes: 10_000 }
const shells: Array<[string, NodeJS.Platform]> = [
  ["bash", "linux"],
  ["zsh", "darwin"],
  ["pwsh", "win32"],
  ["powershell", "win32"],
  ["cmd", "win32"],
]

describe("tool.shell prompt shell identity", () => {
  for (const [name, platform] of shells) {
    test(`${name} description documents shell identity and failure adaptation`, () => {
      const { description } = ShellPrompt.render(name, platform, limits, 120_000)

      expect(description).toContain("## Shell identity and failure adaptation")
      // The three observed failure modes have a documented recovery path.
      expect(description).toContain("heredocs (`<<`)")
      expect(description).toContain("`for f in ...; do ... done` one-liners")
      expect(description).toContain("POSIX `rm` flags")
      expect(description).toContain("not a\n  valid regular expression")
      expect(description).toContain("single-quoted literal")
      expect(description).toContain("write a script file with the\n  `write` tool")
      // Retrying a failed syntax pattern verbatim is explicitly forbidden.
      expect(description).toContain("STOP retrying the same construct")
      expect(description).toContain("Never attempt the same failing syntax pattern more than once.")
    })
  }

  test("no unresolved template placeholders remain", () => {
    for (const [name, platform] of shells) {
      const { description } = ShellPrompt.render(name, platform, limits, 120_000)
      expect(description).not.toMatch(/\$\{\w+\}/)
    }
  })
})
