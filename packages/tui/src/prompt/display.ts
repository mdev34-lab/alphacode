const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Display columns measured with the same Bun width function OpenTUI uses to lay out text. */
export function displayWidth(value: string) {
  return Bun.stringWidth(value)
}

/** Truncate to terminal columns without cutting a Unicode grapheme cluster. */
export function truncateDisplay(value: string, maxWidth: number) {
  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0
  if (displayWidth(value) <= width) return value

  const ellipsis = "…"
  const ellipsisWidth = displayWidth(ellipsis)
  if (width < ellipsisWidth) return ""

  let result = ""
  let used = 0
  const available = width - ellipsisWidth
  for (const part of graphemes.segment(value)) {
    const partWidth = displayWidth(part.segment)
    if (used + partWidth > available) break
    result += part.segment
    used += partWidth
  }
  return result + ellipsis
}

/** Keep a path's final components visible while truncating its leading directories. */
export function truncateDisplayTail(value: string, maxWidth: number) {
  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0
  if (displayWidth(value) <= width) return value

  const ellipsis = "…"
  const ellipsisWidth = displayWidth(ellipsis)
  if (width < ellipsisWidth) return ""

  let result = ""
  let used = 0
  const available = width - ellipsisWidth
  const parts = Array.from(graphemes.segment(value), (part) => part.segment)
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    const partWidth = displayWidth(part)
    if (used + partWidth > available) break
    result = part + result
    used += partWidth
  }
  return ellipsis + result
}

/** Keep both ends of a long path visible while fitting it into terminal columns. */
export function truncateDisplayMiddle(value: string, maxWidth: number) {
  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0
  if (displayWidth(value) <= width) return value

  const ellipsis = "…"
  const ellipsisWidth = displayWidth(ellipsis)
  if (width < ellipsisWidth) return ""

  const parts = Array.from(graphemes.segment(value), (part) => part.segment)
  let leftIndex = 0
  let rightIndex = parts.length - 1
  let left = ""
  let right = ""
  let remaining = width - ellipsisWidth
  let takeLeft = true

  while (leftIndex <= rightIndex) {
    const index = takeLeft ? leftIndex : rightIndex
    const part = parts[index]
    const partWidth = displayWidth(part)
    if (partWidth > remaining) {
      if (leftIndex === rightIndex) break
      const alternate = takeLeft ? rightIndex : leftIndex
      const alternatePart = parts[alternate]
      const alternateWidth = displayWidth(alternatePart)
      if (alternateWidth > remaining) break
      if (takeLeft) {
        right = alternatePart + right
        rightIndex--
      } else {
        left += alternatePart
        leftIndex++
      }
      remaining -= alternateWidth
      takeLeft = !takeLeft
      continue
    }

    if (takeLeft) {
      left += part
      leftIndex++
    } else {
      right = part + right
      rightIndex--
    }
    remaining -= partWidth
    takeLeft = !takeLeft
  }

  return left + ellipsis + right
}

export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    // Textarea offsets count newlines as one position; Bun.stringWidth counts them as zero.
    width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment)
  }
  return width
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end = promptOffsetWidth(value)) {
  return value.slice(displayOffsetIndex(value, start), displayOffsetIndex(value, end))
}

export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}
