import { collapseToolOutput } from "./collapse-tool-output"

// Collapses a single-file unified diff to at most `maxLines` hunk body lines,
// truncating on hunk boundaries. Partial hunks get a rewritten `@@ -a,b +c,d @@`
// header so the result stays a valid diff and the renderer offsets stay correct.
// Non-hunked input falls back to plain line truncation.
export function collapseDiff(diff: string, maxLines: number) {
  const lines = diff.split("\n")
  const preamble: string[] = []
  const hunks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = [line]
      hunks.push(current)
    } else if (current) {
      current.push(line)
    } else {
      preamble.push(line)
    }
  }

  if (hunks.length === 0) {
    const fallback = collapseToolOutput(diff, maxLines, Number.MAX_SAFE_INTEGER)
    return { diff: fallback.output, overflow: fallback.overflow }
  }

  const totalBody = hunks.reduce((total, hunk) => total + Math.max(0, hunk.length - 1), 0)
  if (totalBody <= maxLines) return { diff, overflow: false }

  const out: string[] = [...preamble]
  let budget = maxLines
  for (const hunk of hunks) {
    if (budget <= 0) break
    const [header, ...body] = hunk
    if (body.length <= budget) {
      out.push(header, ...body)
      budget -= body.length
    } else {
      const partial = body.slice(0, budget)
      out.push(rewriteHunkHeader(header, partial), ...partial)
      budget = 0
    }
  }
  return { diff: out.join("\n"), overflow: true }
}

function rewriteHunkHeader(header: string, body: string[]) {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
  if (!match) return header
  let removed = 0
  let added = 0
  for (const line of body) {
    if (line === "") continue
    const first = line[0]
    if (first === "+") added++
    else if (first === "-") removed++
    else if (first === " ") {
      removed++
      added++
    }
    // "\ No newline at end of file" markers and anything else do not count.
  }
  return `@@ -${match[1]},${removed} +${match[3]},${added} @@${match[5]}`
}
