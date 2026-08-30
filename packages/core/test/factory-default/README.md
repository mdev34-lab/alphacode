# Factory-Default Mode Tests

This directory contains tests for the factory-default mode feature that suppresses user-configured extensions.

## Test Plan

### 1. RuntimeFlags factoryDefault ✅
- Verifies the `factoryDefault` flag defaults to `false`
- Verifies the flag can be set to `true` via the RuntimeFlags layer

### 2. MCP factory-default mode
- Verifies that when `factoryDefault` is true, MCP server creation returns a disabled status
- Verifies normal startup (factoryDefault=false) does not return disabled

### 3. Plugin factory-default mode
- Verifies that when `factoryDefault` is true, plugins are not loaded from configuration
- The Plugin service remains available but with no user-configured plugins loaded

### 4. Skill discovery factory-default mode
- Verifies that when `factoryDefault` is true, skill sources are not created from configuration
- The SkillDiscovery service remains available but with no user-configured skills

### 5. Daemon lifecycle factory-default mode (not implemented)
- Would verify that when `factoryDefault` is true, an existing compatible daemon is stopped and a fresh one is spawned
- **Not feasible as a unit test**: the daemon service spawns real child processes (`spawn(process.execPath, ...)`) and makes real HTTP requests to the health endpoint. A unit test would need to mock the SDK client (`createOpencodeClient`) and the `node:child_process` module, which would defeat the purpose of testing the real layer
- Manual verification: run `opencode serve` then `opencode --factory-default` and observe the existing daemon is stopped

## How It Works

The factory-default mode uses the `RuntimeFlags.factoryDefault` flag, which is:
- Set to `false` by default (normal startup behavior)
- Set to `true` when the `--factory-default` CLI flag is used
- Read from the `OPENCODE_FACTORY_DEFAULT` environment variable

When `factoryDefault` is `true`, the following are suppressed:
- **MCP servers**: No MCP servers are started from configuration
- **Plugins**: No user-configured plugins are loaded
- **Skills**: No skills are discovered from configured paths/URLs

Built-in AlphaCode functionality remains available:
- Model/provider mechanism
- Core tools and features
- All built-in functionality

## Test Structure

Tests use the `testEffect` pattern with `Effect.gen` and `Effect.runPromise`. The `RuntimeFlags.layer` is used to set the `factoryDefault` flag for testing.
