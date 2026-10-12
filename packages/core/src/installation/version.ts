declare global {
  const SILVERCODE_VERSION: string
  const SILVERCODE_CHANNEL: string
  const ALPHACODE_VERSION: string
  const ALPHACODE_CHANNEL: string
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// The SilverCode build injects SILVERCODE_*; ALPHACODE_* (pre-rename) and OPENCODE_*
// (inherited) stay as fallbacks so older builds and unchanged OpenCode code keep resolving.
export const InstallationVersion =
  typeof SILVERCODE_VERSION === "string"
    ? SILVERCODE_VERSION
    : typeof ALPHACODE_VERSION === "string"
    ? ALPHACODE_VERSION
    : typeof OPENCODE_VERSION === "string"
      ? OPENCODE_VERSION
      : "local"
export const InstallationChannel =
  typeof SILVERCODE_CHANNEL === "string"
    ? SILVERCODE_CHANNEL
    : typeof ALPHACODE_CHANNEL === "string"
    ? ALPHACODE_CHANNEL
    : typeof OPENCODE_CHANNEL === "string"
      ? OPENCODE_CHANNEL
      : "local"
export const InstallationLocal = InstallationChannel === "local"
