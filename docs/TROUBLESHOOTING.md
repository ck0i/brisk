# Troubleshooting

Start without the TUI:

```sh
brisk version
brisk auth status
brisk models --refresh
brisk sessions
brisk doctor
```

Use `--json` on list/status/doctor commands. Do not attach `auth.db`, callbacks, or transcripts without redacting secrets.

## Install and startup

**`command not found`** — Open a new terminal after `bun add --global --trust brisk-ai`. Check `bun pm bin -g`. Standalone: put the full release directory on `PATH`.

**npm / Node** — Brisk requires Bun ≥ 1.3.14; the package shebang is `#!/usr/bin/env bun`.

**Blank or broken TUI** — Use a real terminal (not a nested TUI pane). Standalone releases need `assets/` and `pi_natives` beside the executable; unset a wrong `OTUI_ASSET_ROOT`. Try `reset` on POSIX if the terminal is wedged.

**Missing natives** — Re-extract the release and verify `SHA256SUMS`. Linux glibc builds are not musl/Alpine standalone targets.

## Auth and models

**No models** — `brisk auth status`, export API keys in the same environment, `brisk models --refresh`, check `defaultModel` spelling and OAuth vs API provider IDs.

**OAuth callback stuck** — Retry in an interactive terminal; paste code/URL only into Brisk. Firewall/remote shells can block localhost callbacks.

**Custom endpoint 401/404** — See [Configuration](CONFIGURATION.md): `baseUrl` prefix, `apiKeyEnv` name vs value, `keyless`, dialect, model metadata.

**Auth DB permissions** — POSIX expects `0700` on the data dir and `0600` on `auth.db`. Move aside a corrupt DB and log in again.

## Config

**JSONC errors** — Diagnostics include file and JSON path. No inline secrets; `baseUrl` must not embed credentials.

**Project config ignored** — Path must be `<workspace>/.brisk/config.jsonc` for the directory you passed to Brisk. CLI overrides win. `/settings` writes the global layer only.

## Tools

**Stale Hashline tag** — `read` again and patch from the new `[path#TAG]` header.

**Unexpected deny** — Check footer permission mode and approval reason. Relative paths cannot escape the workspace via symlinks or `..`; use an explicit absolute path to operate elsewhere. Outside-workspace mutations can still require approval.

**Truncated output** — Follow the `artifact://` reference in the tool result.

## Sessions and context

**Resume** — `--continue` is per canonical workspace; use `brisk sessions` and `brisk --session <id> <workspace>`.

**Truncated JSONL** — Partial final lines are ignored; recovery may copy a `.partial` file.

**Compaction** — Needs a known model context window. Brisk checks every provider turn against the configured percentage using active history, system instructions, and tool schemas, corrected by measured input usage when available. Cache read/write counters are not part of this calculation. `/context` shows current use, and `/compact` while idle always attempts a pass. Each child agent has an independent automatic Snapcompact lifecycle using the same settings.

**Child agents** — Queued when at `maxSubagents`; depth limit returns blocked. Patch children return diffs only. A running child with no provider usage shows “waiting for first response”; live stream/tool events are shown separately because some providers, notably Cursor, delay or omit token accounting. Stalled Cursor child attempts use a 90-second stream deadline, retry from a fresh conversation, and retain the final failure reason in agent detail.
