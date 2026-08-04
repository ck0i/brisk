# Brisk

Brisk is a fast, provider-agnostic terminal coding harness built with Bun, Solid, and OpenTUI. It owns its streaming agent loop, tool execution, permissions, append-only sessions, context compaction, and context-branched subagents while using `@oh-my-pi/pi-ai` for provider transports and authentication.

## Requirements

- Bun 1.3.14 or newer for the npm package and source installation
- A supported terminal on Linux, macOS, or Windows
- Provider credentials, unless a keyless local OpenAI-compatible endpoint is configured

Standalone release directories include Bun and the native runtime assets. Keep each release directory intact; do not move only the executable.

## Install and uninstall

### npm package

The package is named `brisk-ai`; its executable is `brisk`.

```sh
bun add --global --trust brisk-ai
# open a new terminal, then:
brisk version
```

The trusted postinstall only locates the package manager's global binary directory and adds it idempotently to the current user's persistent `PATH`. It updates Bash, Zsh, or Fish startup files on Linux and macOS, and the user environment on Windows. Existing `PATH` entries are left unchanged. Bun blocks dependency lifecycle scripts unless `--trust` is supplied, so that flag is required for automatic setup.

Uninstall it with:

```sh
bun remove --global brisk-ai
```

The shared package-manager binary directory remains in `PATH` because other global packages may use it. The published executable is a prebuilt Bun JavaScript bundle with its Solid JSX transform already applied, so it is independent of the launch directory. Node alone is not a supported runtime for this package.

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
2. **OAuth**: `brisk auth login [provider]` supports Brisk's built-in `anthropic`, `openai-codex`, `google-antigravity`, and `cursor` flows. `/login [provider]` performs the same operation inside the mounted TUI. Stored grants live in the private Brisk auth database and are refreshed upstream.
3. **Custom OpenAI-compatible endpoints**: define a provider with `baseUrl`, models, and either `keyless: true` or `apiKeyEnv: "VARIABLE_NAME"`. Secret values are rejected in configuration.

OAuth is distinct from ordinary provider API billing. For example, `openai-codex` uses ChatGPT/Codex OAuth, while `openai/...` uses `OPENAI_API_KEY`. Some OAuth flows require a pasted authorization code or callback URL when the browser callback cannot complete automatically. Real grants must be manually verified against provider accounts before release; automated tests do not prove provider account access.

Provider-side prompt caching is automatic and uses the persisted Brisk session ID for stable cache affinity. Brisk requests long retention by default; set `PI_CACHE_RETENTION=short` or `PI_CACHE_RETENTION=none` to shorten or disable it. See [Providers and authentication](docs/PROVIDERS.md) for provider mappings and cache behavior. See [Configuration](docs/CONFIGURATION.md) for custom endpoint examples.

## CLI

```text
brisk [directory] [options]
brisk --continue
brisk --session <id>
brisk auth <login|logout|status> [provider] [--json]
brisk models [--refresh] [--json]
brisk sessions [--json]
brisk doctor [--json]
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

`brisk doctor` checks the Bun runtime, OpenTUI native loading, private writable directories, credential presence, model cache, optional tools, terminal capabilities, session index, and extension diagnostics without printing credentials. It exits nonzero only for error-level checks and supports `--json`.

### Slash commands

| Command                                   | Action                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/help`                                   | Show keys and commands.                                                                  |
| `/model [provider/model]`                 | Select from available models or select the exact model.                                  |
| `/login [provider]`, `/logout [provider]` | Manage an OAuth grant inside the mounted TUI.                                            |
| `/new`                                    | Start a new session in the current workspace.                                            |
| `/sessions`, `/resume`                    | Open the workspace session picker.                                                       |
| `/compact`                                | Compact context immediately when the agent is idle.                                      |
| `/context`                                | Show token estimates, threshold, retained messages, and compaction mode.                 |
| `/agents`                                 | Open child-agent list/detail state and transcripts.                                      |
| `/cost`                                   | Show recorded session cost.                                                              |
| `/settings`                               | Interactively edit and apply global runtime settings.                                    |
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

## AGENTS.md instructions

Brisk injects discovered `AGENTS.md` files as system context on the first provider request and every continuation, including child agents. It loads user defaults from the platform configuration directory's `AGENTS.md`, then recursively discovers repository `AGENTS.md` files from the selected workspace downward. Version-control metadata and common generated/dependency directories are not scanned. `/reload` discovers the files again.

Repository instructions take precedence over user-level defaults. A repository `AGENTS.md` applies to its containing directory and descendants; for a target file, a more deeply nested applicable file takes precedence over a shallower one. Unrelated directory scopes do not affect each other. A direct request in the conversation remains authoritative.

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

The parent model can call `task` for `research` or `patch` work. Children share one immutable, content-addressed checkpoint of prepared parent context, but each has an isolated provider continuation and persisted child session. Concurrency and depth are bounded by configuration. `defaultSubtaskModel` selects the child model when a task omits its model; otherwise children inherit the active parent model. Per-task model selection remains available only when a particular task needs an override.

Research children receive read/search/find/list/bash tools under the normal permission policy. Patch children edit an in-memory overlay, never the real workspace. Their deterministic unified diff returns to the parent; it is not silently applied. `/agents` displays queued, running, completed, blocked, failed, and cancelled children with model, mode, token usage, and transcript detail.

## Extensions

Place global `.ts`, `.js`, or `.mjs` extension entries in the platform configuration directory's `extensions/` child, or project entries in `<workspace>/.brisk/extensions/`. Project entries require an explicit first-use approval before import. Extensions can register tools, slash commands, keybindings, predefined UI-slot text, and lifecycle hooks through the documented API. Built-in names take precedence, failures are isolated and redacted, and `/reload` replaces the active extension generation. See [the extension guide](docs/EXTENSIONS.md) for paths and the complete API.

## Security model

Brisk assumes the selected model and tool outputs are untrusted inputs. It validates tool schemas, confines workspace mutations, separates preview from commit, redacts known secrets from approvals, limits output, cleans process trees, and keeps auth/session/artifact directories private where the platform supports POSIX modes. Configuration rejects inline secret fields and URLs containing credentials.

Brisk is not an OS sandbox. `bash`, approved writes, providers, local endpoint servers, and extensions of the host environment retain their operating-system privileges. Review approvals and diffs, use `safe` for unfamiliar repositories, protect the Brisk data directory, and keep secrets out of prompts and workspace files.

## More documentation

- [Configuration](docs/CONFIGURATION.md)
- [Providers and authentication](docs/PROVIDERS.md)
- [Extensions](docs/EXTENSIONS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

Brisk is licensed under the [MIT License](LICENSE).
