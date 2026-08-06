# Brisk

Brisk is a provider-agnostic terminal coding harness (Bun, Solid, OpenTUI). It owns the agent loop, tools, permissions, sessions, context compaction, and subagents; [`@oh-my-pi/pi-ai`](https://www.npmjs.com/package/@oh-my-pi/pi-ai) handles provider transports and authentication.

## Requirements

- Bun **1.3.14+**
- Linux, macOS, or Windows terminal
- Provider credentials, or a keyless local OpenAI-compatible endpoint

## Install

**npm** — package `brisk-ai`, binary `brisk`:

```sh
bun add --global --trust brisk-ai
brisk version
```

Use `--trust` so postinstall can add Bun's global bin directory to your `PATH`. Node is not supported.

**Standalone** — download the release for your platform (`brisk-linux-x64`, `brisk-linux-arm64`, `brisk-darwin-x64`, `brisk-darwin-arm64`, or `brisk-windows-x64`) and use its directory as-is. Verify `brisk-release-SHA256SUMS` before extracting when installing manually.

**Source:**

```sh
bun install --frozen-lockfile
bun run dev
```

Brisk checks for a newer release after the TUI's first frame. When notified, update either a global package installation or a complete standalone release directory with:

```sh
brisk update
```

User data and config paths: [Configuration](docs/CONFIGURATION.md).

## First run

```sh
export ANTHROPIC_API_KEY='...'   # or: brisk auth login anthropic
brisk models --refresh
brisk --model anthropic/claude-sonnet-4-5 /path/to/project
```

The TUI mounts before configuration, sessions, providers, or network I/O. Set `defaultModel` in config to skip interactive model selection.

## CLI

```text
brisk [directory] [--model M] [--permission-mode safe|write|yolo] [--continue | --session ID] [--fake-provider]
brisk auth <login|logout|status> [provider]
brisk models [--refresh]   brisk sessions   brisk doctor   brisk bench   brisk update   brisk version
```

Slash commands, keybindings, and permission modes: [Usage](docs/USAGE.md). Providers and OAuth: [Providers](docs/PROVIDERS.md).

## Documentation

| Topic                   | Document                                           |
| ----------------------- | -------------------------------------------------- |
| Configuration and paths | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)     |
| Auth and models         | [docs/PROVIDERS.md](docs/PROVIDERS.md)             |
| MCP servers             | [docs/MCP.md](docs/MCP.md)                         |
| Extensions              | [docs/EXTENSIONS.md](docs/EXTENSIONS.md)           |
| Interactive reference   | [docs/USAGE.md](docs/USAGE.md)                     |
| Problems                | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Code layout             | [ARCHITECTURE.md](ARCHITECTURE.md)                 |
| Contributing            | [CONTRIBUTING.md](CONTRIBUTING.md)                 |

[Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [MIT License](LICENSE)
