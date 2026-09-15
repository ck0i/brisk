# Providers and authentication

Transports, OAuth, refresh, and prompt-cache wire formats are handled by `@oh-my-pi/pi-ai`, except Cursor. Cursor models run through the Cursor Agent SDK (`@cursor/sdk`). Brisk still owns the agent loop, tools, and sessions.

## API keys

Set env vars in the shell that launches `brisk` (never in JSONC):

| Provider                    | Variable                   |
| --------------------------- | -------------------------- |
| Anthropic API               | `ANTHROPIC_API_KEY`        |
| OpenAI API                  | `OPENAI_API_KEY`           |
| Gemini API                  | `GEMINI_API_KEY`           |
| OpenCode Go API             | `OPENCODE_API_KEY`         |
| Anthropic OAuth override    | `ANTHROPIC_OAUTH_TOKEN`    |
| OpenAI Codex OAuth override | `OPENAI_CODEX_OAUTH_TOKEN` |
| Cursor override             | `CURSOR_ACCESS_TOKEN`      |
| Cursor Agent SDK            | `CURSOR_API_KEY`           |

`brisk auth status` lists configured providers without printing values.

## OAuth

```text
brisk auth login anthropic | openai-codex | google-antigravity | cursor | opencode-go
brisk auth status
brisk auth logout <provider>
```

`/login` and `/logout` work in the TUI. Grants live in `<data>/auth.db`. Logout is local only—revoke at the provider when needed.

**IDs matter:** `openai-codex` is ChatGPT/Codex OAuth, not `openai/...` + `OPENAI_API_KEY`. `google-antigravity` is distinct from `google/...` + `GEMINI_API_KEY`.

Some flows need a pasted callback URL or code when the browser cannot complete automatically.

## OpenCode Go

OpenCode Go is OpenCode's paid coding subscription ([opencode.ai/go](https://opencode.ai/go)). `brisk auth login opencode-go` and `/login` open [opencode.ai/auth](https://opencode.ai/auth) and store the API key you paste, so the flow ends with a stored key rather than an OAuth callback. `OPENCODE_API_KEY` is the equivalent environment fallback for the same subscription key.

Select Go models as `opencode-go/<model-id>`, for example `opencode-go/kimi-k2.7-code`. `brisk models` prints the bundled Go catalog.

## Cursor Agent SDK

Cursor models use Cursor's local Agent SDK, not the Cursor CLI protocol. Brisk creates a durable local agent against the workspace and sends each user turn with `agent.send()`. Built-in Cursor file and shell tools stay disabled. Brisk registers its own tools as SDK custom tools, so Hashline, path jail, and permission checks still run.

Set `CURSOR_API_KEY` from [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api). `brisk auth login cursor` still stores the existing Cursor OAuth grant. Brisk passes a stored Cursor credential first. If none exists, it uses `CURSOR_API_KEY`.

## Models

```text
brisk models [--refresh]
brisk --model provider/model
```

Cached catalog shows immediately; availability refreshes asynchronously. Set `defaultModel` in config or use `/model`.

Model selection is followed by an effort picker derived from that model's catalog metadata. `/effort` changes the active main model; `/effort subagent` changes the child default; `/effort advisor` changes the configured advisor model. Unsupported levels are not offered, non-reasoning models resolve to `off`, and `auto` uses the provider default.

## Prompt caching

Enabled by default per provider capabilities. `PI_CACHE_RETENTION=short` or `none` adjusts retention. Session identity is stable per Brisk session for cache affinity.

## Custom endpoints

Define providers in [Configuration](CONFIGURATION.md). Test `baseUrl`, dialect (`api`), model IDs, and `apiKeyEnv`/`keyless` against the server directly when debugging 401/404.

## Release verification

Manual OAuth checks before publish: [dev/oauth-checklist.md](dev/oauth-checklist.md).
