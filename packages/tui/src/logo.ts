// Single source of truth for the alphacode ANSI wordmark.
//
// Every glyph is four columns wide (the "l" is a single column) and is drawn on
// a half-block grid: one terminal cell is two vertical half cells. Row 0 holds
// ascender tips, rows 1-3 hold the letter body, and row 3 also holds descenders.
// Ascenders ("l", "h", "d") all rise exactly one half cell above x-height.
//
// Besides the block characters the templates use shadow marks, expanded by each
// renderer (tui/component/logo.tsx, tui/util/presentation.ts, cli/ui.ts,
// cli/cmd/run/splash.ts, tui/component/bg-pulse-render.ts):
//
//   _  full-cell shadow (letter counter)
//   ^  foreground upper half over a shadow lower half (crossbar)
//   ~  shadow upper half over the terminal background (open counter)
export const logo = {
  left: ["     ▄      ▄        ", " ▀▀█ █ █▀▀█ █▀▀▄  ▀▀█", "█^^█ █ █__█ █__█ █^^█", "▀▀▀▀ ▀ █▀▀▀ ▀~~▀ ▀▀▀▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

// Compact mark used by the run splash: the leading "a" of the wordmark.
export const badge = logo.left.map((row) => row.slice(0, 4))

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
