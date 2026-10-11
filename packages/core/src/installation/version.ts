declare global {
  const ALPHACODE_VERSION: string
  const ALPHACODE_CHANNEL: string
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// The AlphaCode build injects ALPHACODE_*; OPENCODE_* is the inherited alias and
// stays as a fallback so unchanged OpenCode code keeps resolving its globals.
export const InstallationVersion =
  typeof ALPHACODE_VERSION === "string"
    ? ALPHACODE_VERSION
    : typeof OPENCODE_VERSION === "string"
      ? OPENCODE_VERSION
      : "local"
export const InstallationChannel =
  typeof ALPHACODE_CHANNEL === "string"
    ? ALPHACODE_CHANNEL
    : typeof OPENCODE_CHANNEL === "string"
      ? OPENCODE_CHANNEL
      : "local"
export const InstallationLocal = InstallationChannel === "local"
