// Single source of truth for the application product name shown in the TUI.
//
// The sidebar footer renders this as a two-tone inline wordmark: the prefix in
// the muted text color and the suffix in the foreground text color. Centralizing
// the name here (mirroring logo.ts for the ANSI wordmark) keeps the sidebar
// label in lockstep with the rest of the AlphaCode branding instead of letting
// each call site hardcode its own copy.
export const BRAND_NAME = "AlphaCode"

// Stylistic split used by the inline sidebar wordmark. The prefix inherits the
// surrounding muted color while the suffix is drawn in the foreground text color.
export const BRAND_PREFIX = "Alpha"
export const BRAND_SUFFIX = "Code"
