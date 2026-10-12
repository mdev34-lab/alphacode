// The exerciser gates HTTP routes, not config dependency installs. Every
// instance boot otherwise forks a real `@opencode-ai/plugin` registry install
// per config directory, and a stalled registry wedges instance disposal
// (scope close awaits the uncancelable install fiber), which hung the Linux
// CI gate for the full action timeout. Keep every exerciser boot hermetic.
process.env.OPENCODE_DISABLE_CONFIG_DEP_INSTALL = "1"
await import("../test/server/httpapi-exercise/index")
