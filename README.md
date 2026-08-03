# Brisk

Brisk is a fast, provider-agnostic terminal coding harness built with Bun, Solid, and OpenTUI. It owns its streaming agent loop, tool execution, permissions, append-only sessions, context compaction, and context-branched subagents while using `@oh-my-pi/pi-ai` for provider transports and authentication.

## Requirements

- Bun 1.3.14 or newer for the npm package and source installation
- A supported terminal on Linux, macOS, or Windows
- Provider credentials, unless a keyless local OpenAI-compatible endpoint is configured

Standalone release directories include Bun and the native runtime assets. Keep the directory intact rather than moving only the executable.

## Install and uninstall

### npm package

The package is named `brisk-ai`; its executable is `brisk`.

```sh
bun add --global brisk-ai
brisk version
```

Uninstall it with:

```sh
bun remove --global brisk-ai
```

The published executable entry is the Bun-shebang TypeScript file declared in `package.json`. Node alone is not a supported runtime for this package.

### Standalone release

Download the release directory for the platform, verify `SHA256SUMS`, and put that directory on `PATH`, or link its `brisk`/`brisk.exe` into a directory already on `PATH`. Do not separate the executable from `assets/` or the adjacent `pi_natives` files.

Remove the directory and any link to uninstall. User configuration, credentials, sessions, and artifacts are deliberately not removed; their locations are listed in [Configuration](docs/CONFIGURATION.md).

### From source

```sh
git clone <repository-url>
cd brisk
bun install --frozen-lockfile
bun run dev
```

## First run

Choose one authentication path, inspect available models, then open a workspace:

```sh
# API-key example
export ANTHROPIC_API_KEY='...'
brisk models --refresh
brisk --model anthropic/claude-sonnet-4-5 /path/to/project
```

Or use a supported OAuth grant:

```sh
brisk auth login anthropic
brisk auth status
brisk /path/to/project
```

With no configured or available model, the UI still opens and directs you to `/login`, `/model`, or API-key configuration. `defaultModel` can remove the selection step. Brisk mounts the terminal UI before loading configuration, sessions, providers, model catalogs, tools, or network state.

## Providers and authentication

Brisk supports three credential paths:

1. **Environment API keys**: set the provider's variable in the environment that launches Brisk. Common mappings are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`. OAuth-token overrides include `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_CODEX_OAUTH_TOKEN`, and `CURSOR_ACCESS_TOKEN`. `brisk auth status` reports recognized configured providers and the environment-variable source without printing values.
2. **OAuth**: `brisk auth login [provider]` supports Brisk's built-in `anthropic`, `openai-codex`, `google-antigravity`, and `cursor` flows. `/login [provider]` performs the same operation from the TUI while temporarily suspending rendering. Stored grants live in the private Brisk auth database and are refreshed upstream.
3. **Custom OpenAI-compatible endpoints**: define a provider with `baseUrl`, models, and either `keyless: true` or `apiKeyEnv: "VARIABLE_NAME"`. Secret values are rejected in configuration.

OAuth is distinct from ordinary provider API billing. For example, `openai-codex` uses ChatGPT/Codex OAuth, while `openai/...` uses `OPENAI_API_KEY`. Some OAuth flows require a pasted authorization code or callback URL when the browser callback cannot complete automatically. Real grants must be manually verified against provider accounts before release; automated tests do not prove provider account access.

See [Providers and authentication](docs/PROVIDERS.md) for flow-specific details and the manual verification checklist. See [Configuration](docs/CONFIGURATION.md) for custom endpoint examples.

## CLI

```text
brisk [directory] [options]
brisk --continue
brisk --session <id>
brisk auth <login|logout|status> [provider] [--json]
brisk models [--refresh] [--json]
brisk sessions [--json]
brisk bench [--json]
brisk version
```

Interactive options:

- `--model <provider/model>` selects a model.
- `--permission-mode <safe|write|yolo>` overrides the configured policy.
- `--continue`, or `-c`, resumes the most recently updated session for the workspace.
- `--session <id>` resumes a specific session.
- `--fake-provider` enables the deterministic development provider.
- `--help`, `-h`, `--version`, and `-v` show metadata without starting the TUI.

`brisk doctor` is a reserved command in 0.1.0 but is not implemented. Use [Troubleshooting](docs/TROUBLESHOOTING.md) and the status commands above.

### Slash commands

| Command                                   | Action                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/help`                                   | Show keys and commands.                                                                  |
| `/model [provider/model]`                 | Select from available models or select the exact model.                                  |
| `/login [provider]`, `/logout [provider]` | Manage an OAuth grant while the TUI is suspended.                                        |
| `/new`                                    | Start a new session in the current workspace.                                            |
| `/sessions`, `/resume`                    | Open the workspace session picker.                                                       |
| `/compact`                                | Compact context immediately when the agent is idle.                                      |
| `/context`                                | Show token estimates, threshold, retained messages, and compaction mode.                 |
| `/agents`                                 | Open child-agent list/detail state and transcripts.                                      |
| `/cost`                                   | Show recorded session cost.                                                              |
| `/settings`                               | Show the global configuration path.                                                      |
| `/reload`                                 | Reload JSONC configuration. Provider-definition changes take effect on the next session. |
| `/clear`                                  | Clear visible UI messages without deleting the persisted transcript.                     |
| `/quit`                                   | Exit.                                                                                    |

### Keybindings

| Key                                                 | Action                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Enter`                                             | Submit. During active work, submitted text steers the running turn.                                  |
| `Shift+Enter`, `Ctrl+Enter`, `Meta+Enter`, `Ctrl+J` | Insert a newline.                                                                                    |
| `Esc`                                               | Abort active work.                                                                                   |
| `Ctrl+C`                                            | Abort while busy; exit while idle.                                                                   |
| `Ctrl+P`                                            | Open the model picker.                                                                               |
| `Ctrl+O`                                            | Open the session picker.                                                                             |
| `Up`/`Down` or `Ctrl+K`/`Ctrl+J`                    | Move in pickers and the agent panel.                                                                 |
| `Enter`/`Esc`                                       | Accept/cancel a picker; open/back in the agent panel.                                                |
| `C`                                                 | Cancel the selected child agent.                                                                     |
| `A`, `S`, `D`                                       | Approve once, approve equivalent operations for the session, or deny an approval. `Esc` also denies. |

## Coding tools and Hashline

The parent agent can `read`, `edit`, `write`, `search`, `find`, `list`, and run bounded `bash` commands. Paths are jailed to the canonical workspace for mutation. Large outputs are truncated for model/UI use and retained in private `artifact://` storage.

Reads return a Hashline header such as `[src/file.ts#TAG]` plus numbered line anchors. Edits must use that exact snapshot tag and native Hashline patch syntax. Brisk stages all sections, builds a unified-diff approval preview, revalidates files and path boundaries, then publishes the transaction atomically. Stale snapshots, symlink escapes, binary/NUL input, no-op replacements, and oversized previews fail before publication. Multi-file publication attempts rollback on failure.

Permission modes are policy presets, not security sandboxes:

- `safe`: read-only tools are automatic; writes, delegated patches, and shell commands prompt.
- `write`: workspace edits are automatic; shell commands and delegated patches prompt.
- `yolo`: ordinary supported operations are automatic.

Critical destructive, workspace-escape, and secret-exposure classifications can still prompt or block in every mode. Approval prompts redact known environment secret values.

## Sessions

Sessions are workspace-scoped append-only JSONL transcripts with incremental assistant text/tool events, model changes, usage, compaction records, errors, cancellations, and child references. Files are private on POSIX systems. `brisk sessions` lists the disposable index; Brisk can rebuild the index from transcripts. A truncated final line is preserved as a recovery artifact and ignored, and an interrupted assistant response is shown diagnostically rather than sent back as complete context.

Use `--continue`, `--session`, `/sessions`, `/resume`, or `Ctrl+O` to resume. `/clear` only affects the current screen. Session transcripts contain prompt and tool content, so treat the data directory as sensitive even though credentials are stored separately.

## Snapcompact context management

Brisk estimates text, image, tool, and usage pressure against the selected model's context window. At the configured threshold it dynamically loads Snapcompact, summarizes old history, preserves structured archive data and file-operation context, and retains a recent tail. Vision-capable models can receive rendered archive frames; non-vision models receive a deterministic bounded text archive. Compaction metadata is appended to the session and restored on resume. Provider overflow triggers one forced-compaction retry.

`/context` inspects the active estimate and `/compact` forces a pass. Unknown model context windows disable threshold-based automatic compaction but not explicit compaction.

## Subagents

The parent model can call `task` for `research` or `patch` work. Children share one immutable, content-addressed checkpoint of prepared parent context, but each has an isolated provider continuation and persisted child session. Concurrency and depth are bounded by configuration.

Research children receive read/search/find/list/bash tools under the normal permission policy. Patch children edit an in-memory overlay, never the real workspace. Their deterministic unified diff returns to the parent; it is not silently applied. `/agents` displays queued, running, completed, blocked, failed, and cancelled children with model, mode, token usage, and transcript detail.

## Security model

Brisk assumes the selected model and tool outputs are untrusted inputs. It validates tool schemas, confines workspace mutations, separates preview from commit, redacts known secrets from approvals, limits output, cleans process trees, and keeps auth/session/artifact directories private where the platform supports POSIX modes. Configuration rejects inline secret fields and URLs containing credentials.

Brisk is not an OS sandbox. `bash`, approved writes, providers, local endpoint servers, and extensions of the host environment retain their operating-system privileges. Review approvals and diffs, use `safe` for unfamiliar repositories, protect the Brisk data directory, and keep secrets out of prompts and workspace files.

## More documentation

- [Configuration](docs/CONFIGURATION.md)
- [Providers and authentication](docs/PROVIDERS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

Brisk is licensed under the [MIT License](LICENSE).
