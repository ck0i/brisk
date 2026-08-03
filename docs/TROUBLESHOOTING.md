# Troubleshooting

Start with commands that do not mount the TUI:

```sh
brisk version
brisk auth status
brisk models --refresh
brisk sessions
brisk doctor
```

Add `--json` to the status/list/doctor commands when collecting machine-readable diagnostics. `brisk doctor` checks the runtime, native UI, writable directories, credential presence, model cache, optional tools, terminal, session index, and extension failures, and suggests concrete fixes. Do not attach auth databases, callback URLs, session transcripts, or environment dumps to reports without reviewing them for secrets.

## Installation and startup

### `brisk: command not found`

For the npm installation, confirm Bun's global binary directory is on `PATH`:

```sh
bun pm bin -g
```

Reinstall with `bun add --global brisk-ai`. For a standalone release, put the extracted release directory on `PATH` or link the executable from it. On POSIX, confirm the executable bit is present.

### The npm package opens under Node and fails

Brisk requires Bun. The `brisk-ai` package exposes a `#!/usr/bin/env bun` entrypoint. Do not invoke `node src/main.ts`; install Bun 1.3.14 or newer and ensure `env bun` resolves to it.

### Missing OpenTUI asset or native library

Standalone releases are directories, not single-file distributions. Keep these together:

- `brisk` or `brisk.exe`
- `assets/`, including the target OpenTUI library and parser data
- adjacent `pi_natives.*.node` files

The compiled launcher sets `OTUI_ASSET_ROOT` to its adjacent `assets` directory unless the variable is already set. Unset a stale custom `OTUI_ASSET_ROOT`, or point it to a complete absolute asset tree. Re-extract the release and verify `SHA256SUMS` if any file is missing.

The packaged Linux release targets use OpenTUI's glibc native library. The listed standalone targets do not include a musl/Alpine release. Use the Bun npm package with platform-resolved dependencies or build an appropriate distribution when running on musl.

### Terminal is blank, corrupted, or immediately exits

- Use a terminal with normal ANSI/alternate-screen support and a meaningful `TERM` value.
- Do not pipe the interactive TUI through a non-terminal. The metadata commands can be redirected safely.
- Reset a terminal left in a bad mode with `reset` on POSIX, then retry.
- Check that the workspace argument exists and is a directory.
- On Windows, use a current Windows Terminal or another modern VT-capable host.

`brisk bench` performs a headless first-draw measurement; it does not validate the native terminal, provider, or complete interactive runtime.

## Models and authentication

### `No model is selected` or no available models

1. Run `brisk auth status` and confirm the expected provider is configured.
2. For API keys, verify the variable is exported in the same environment that launches Brisk. Do not put the value in `.brisk/config.jsonc`.
3. Run `brisk models --refresh` and use an entry marked available.
4. Select the exact `provider/model` with `--model` or `/model`.
5. Check `defaultModel` spelling and custom provider model IDs.

An OAuth provider ID and an API provider ID may differ. `openai-codex` is subscription-backed OAuth; `openai/...` uses `OPENAI_API_KEY`. `google-antigravity` OAuth is distinct from `google/...` Gemini API access.

### OAuth browser callback does not complete

Keep the original terminal open. Depending on provider/platform, Brisk may ask for an authorization code or complete callback URL. Paste only into the waiting Brisk prompt. Local callback ports can be blocked by firewalls, remote shells, containers, and browser/terminal host separation.

Retry `brisk auth login <provider>` in an interactive terminal. If a browser cannot be launched, open the displayed URL manually. Cursor's polling flow can take a short time to observe cancellation. Never publish callback URLs: they can contain short-lived codes and state.

Automated tests use fake credential stores and cannot establish that a real account grant works. Follow the manual account checklist in [Providers](PROVIDERS.md) for every release/provider combination.

### OAuth succeeds but the model is unavailable

Run `brisk models --refresh`. Confirm the grant belongs to the expected account and product, then check provider-specific catalog access. Logout only removes the local credential; revoke a bad grant from the provider's account-security page before logging in again.

### Custom endpoint cannot authenticate or returns 404

- `baseUrl` must be absolute, contain no inline credentials, and include the API prefix expected by the server.
- Use `keyless: true` only for a genuinely unauthenticated endpoint.
- Otherwise set `apiKeyEnv` to the variable **name**, export the value, and restart Brisk.
- Select the endpoint dialect: `openai-completions` or `openai-responses`.
- Ensure the configured model ID, image capability, context size, output cap, and tool-calling flag match the server.

Test the server independently to distinguish transport/authentication failures from Brisk configuration.

### Auth storage permissions or corruption

The auth database is under the platform data root. Brisk attempts `0700` on its directory and `0600` on the database on POSIX. Restore ownership to the current account and remove group/other access. Back up the file before destructive recovery. If the database cannot be opened, move it aside, log in again, and revoke obsolete remote grants separately.

## Configuration

### JSONC fails to load

Diagnostics identify the source and JSON path. Check:

- comments are allowed, but keys and string values still require JSON quotes;
- numeric bounds in [Configuration](CONFIGURATION.md);
- custom providers have all required final fields after layering;
- no secret-like inline provider fields are present;
- `baseUrl` has no `user:password@` component;
- `apiKeyEnv` is a valid environment-variable name.

Unknown fields are warnings and are ignored. `/reload` retains the previous valid in-memory configuration when loading fails. Provider-definition changes take effect on the next session rather than replacing an active provider transport.

### Project settings appear ignored

Project configuration must be exactly `<workspace>/.brisk/config.jsonc`, where the workspace is the directory passed to Brisk. CLI overrides win over project/global values. Objects merge recursively, but arrays replace lower-layer arrays. `/settings` prints the global path, not the project path.

`compaction.enabled`, `ui.theme`, and `ui.showThinking` are accepted but reserved in 0.1.0; see [Configuration](CONFIGURATION.md) for current behavior.

## Tools and approvals

### Hashline edit reports a stale tag or mismatch

Read the file again and construct a new native Hashline patch from the returned `[path#TAG]` header and numbered anchors. Tags bind edits to a snapshot. A concurrent file change between preview and commit is rejected intentionally; approve only a regenerated diff.

A read range records only the displayed lines. Request all lines needed to anchor the edit. Split oversized read output or diff previews into smaller operations.

### Write/edit is denied unexpectedly

Check the footer's active permission mode and the approval reason. `safe` prompts for writes; `write` permits ordinary workspace edits but prompts for shell and patch delegation; `yolo` permits ordinary operations. Critical classifiers still prompt or block across modes. Session approval applies only to a narrowly equivalent operation and is cleared with the session runtime.

Mutations cannot escape the canonical workspace through `..`, absolute outside paths, or symlink changes. Binary/NUL content and invalid UTF-8 are rejected by text tools.

### Bash times out or leaves a process

Brisk sends termination to the spawned process tree on timeout/cancellation and performs process cleanup at shutdown. A process that daemonizes outside the tracked tree may outlive it; inspect with platform process tools. Use a narrower command and timeout. Do not use the TUI as a substitute for an OS sandbox.

### Tool output is truncated

The bounded head/tail view includes an `artifact://` reference when full output was retained. Ask the agent to read a smaller range from that artifact. Artifacts live in the private data root and may contain sensitive command output.

## Sessions and context

### Resume cannot find a session

`--continue` is workspace-specific and uses the canonical workspace path. Run `brisk sessions` to list all indexed records, then `brisk --session <id> <workspace>`. If the disposable index is missing/corrupt, session repository startup rebuilds it from valid JSONL transcripts.

Do not rename transcript files independently; IDs and filenames are validated together.

### Session reports a truncated line or interrupted response

An unterminated final JSONL record is ignored and copied to a `.partial` recovery file when possible. Brisk resumes from the last valid sequence. Partial assistant text/tool arguments remain diagnostic UI content but are not treated as a complete provider-context message. Preserve the transcript before manual repair.

### Compaction does not run automatically

Automatic compaction needs a positive context window from the selected model and enough estimated use to reach `thresholdPercent`. Inspect `/context`. Explicit `/compact` is still available while idle.

### Snapcompact or compaction fails

Confirm the standalone release assets/native addons are intact, or rerun `bun install` for a source/npm installation. Retry with `/compact`. A non-vision model uses structured text fallback rather than rendered frames. A provider context-overflow error triggers only one forced-compaction retry; repeated overflow is returned as an error rather than looped indefinitely.

### Child agent is queued, blocked, or cancelled

`maxSubagents` limits concurrency, so additional children remain queued. `maxSubagentDepth` bounds nesting; reaching it returns a blocked result. `/agents` shows status/transcript and `C` cancels the selected running/queued child. Parent cancellation is propagated. Patch children work in overlays and return diffs; they do not directly modify the workspace.

## Release verification

From a source checkout:

```sh
bun install --frozen-lockfile
bun run build:verify
```

This cleans and rebuilds the host target release directory, writes a manifest and `SHA256SUMS`, runs its executable with `version`, and requires exact `brisk <package-version>` output. Cross targets can be built with `bun run build -- --all`, but cannot be executed or verified by the host verification mode. Validate each cross artifact on its actual operating system before publishing; do not infer runtime success from cross-compilation alone.
