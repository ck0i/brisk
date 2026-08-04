# Providers and authentication

Transports, OAuth, refresh, and prompt-cache wire formats are handled by `@oh-my-pi/pi-ai`. Brisk owns the agent loop, tools, and sessions.

## API keys

Set env vars in the shell that launches `brisk` (never in JSONC):

| Provider                    | Variable                   |
| --------------------------- | -------------------------- |
| Anthropic API               | `ANTHROPIC_API_KEY`        |
| OpenAI API                  | `OPENAI_API_KEY`           |
| Gemini API                  | `GEMINI_API_KEY`           |
| Anthropic OAuth override    | `ANTHROPIC_OAUTH_TOKEN`    |
| OpenAI Codex OAuth override | `OPENAI_CODEX_OAUTH_TOKEN` |
| Cursor override             | `CURSOR_ACCESS_TOKEN`      |

`brisk auth status` lists configured providers without printing values.

## OAuth

```text
brisk auth login anthropic | openai-codex | google-antigravity | cursor
brisk auth status
brisk auth logout <provider>
```

`/login` and `/logout` work in the TUI. Grants live in `<data>/auth.db`. Logout is local only—revoke at the provider when needed.

**IDs matter:** `openai-codex` is ChatGPT/Codex OAuth, not `openai/...` + `OPENAI_API_KEY`. `google-antigravity` is distinct from `google/...` + `GEMINI_API_KEY`.

Some flows need a pasted callback URL or code when the browser cannot complete automatically.

## Models

```text
brisk models [--refresh]
brisk --model provider/model
```

Cached catalog shows immediately; availability refreshes asynchronously. Set `defaultModel` in config or use `/model`.

Model selection is followed by an effort picker derived from that model's catalog metadata. `/effort` changes the active main model; `/effort subagent` changes the child default. Unsupported levels are not offered, non-reasoning models resolve to `off`, and `auto` uses the provider default.

## Prompt caching

Enabled by default per provider capabilities. `PI_CACHE_RETENTION=short` or `none` adjusts retention. Session identity is stable per Brisk session for cache affinity.

## Custom endpoints

Define providers in [Configuration](CONFIGURATION.md). Test `baseUrl`, dialect (`api`), model IDs, and `apiKeyEnv`/`keyless` against the server directly when debugging 401/404.

## Release verification

Manual OAuth checks before publish: [dev/oauth-checklist.md](dev/oauth-checklist.md).
