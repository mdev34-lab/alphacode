# silvercode

The open source AI coding agent.

[![Discord](https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord)](https://github.com/mdev34-lab/silvercode)
[![Build status](https://img.shields.io/github/actions/workflow/status/mdev34-lab/silvercode/publish.yml?style=flat-square&branch=dev)](https://github.com/mdev34-lab/silvercode/actions/workflows/publish.yml)

## Installation

> [!NOTE]
> **This is the silvercode fork** — it is not published to any package registry; the only supported install is building from source. (Looking for the published [opencode](https://github.com/anomalyco/opencode) project this fork tracks? Use its own install channels.)

```bash
git clone https://github.com/mdev34-lab/silvercode.git
cd silvercode
bun install
./packages/opencode/script/build.ts --single
# binary: ./packages/opencode/dist/silvercode-ai-<platform>/bin/silvercode (e.g. linux-x64, darwin-arm64)
```

> **Note:** the executable is now named `silvercode`. Config and data paths (`~/.opencode`) are unchanged.