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
| Command Code API            | `COMMAND_CODE_API_KEY`     |
| Anthropic OAuth override    | `ANTHROPIC_OAUTH_TOKEN`    |
| OpenAI Codex OAuth override | `OPENAI_CODEX_OAUTH_TOKEN` |
| Cursor override             | `CURSOR_ACCESS_TOKEN`      |
| Cursor Agent SDK            | `CURSOR_API_KEY`           |

`brisk auth status` lists configured providers without printing values.

## OAuth

```text
brisk auth login anthropic | openai-codex | google-antigravity | cursor | opencode-go | commandcode
brisk auth status
brisk auth logout <provider>
```

`/login` and `/logout` work in the TUI. Grants live in `<data>/auth.db`. Logout is local only—revoke at the provider when needed.

**IDs matter:** `openai-codex` is ChatGPT/Codex OAuth, not `openai/...` + `OPENAI_API_KEY`. `google-antigravity` is distinct from `google/...` + `GEMINI_API_KEY`.

Some flows need a pasted callback URL or code when the browser cannot complete automatically.

## OpenCode Go

OpenCode Go is OpenCode's paid coding subscription ([opencode.ai/go](https://opencode.ai/go)). `brisk auth login opencode-go` and `/login` open [opencode.ai/auth](https://opencode.ai/auth) and store the API key you paste, so the flow ends with a stored key rather than an OAuth callback. `OPENCODE_API_KEY` is the equivalent environment fallback for the same subscription key.

Select Go models as `opencode-go/<model-id>`, for example `opencode-go/kimi-k2.7-code`. `brisk models` prints the bundled Go catalog.

## Command Code

Command Code's Provider API ([commandcode.ai](https://commandcode.ai)) also signs in with a pasted key. `brisk auth login commandcode` and `/login` open [Command Code Studio](https://commandcode.ai/studio), where you create or copy a Provider API key. `COMMAND_CODE_API_KEY` (or `COMMANDCODE_API_KEY`) is the environment fallback.

Some Command Code model ids contain their own slash, and only the first slash separates the provider, for example `commandcode/claude-sonnet-5` or `commandcode/deepseek/deepseek-v4-pro`. Claude models go through Command Code's Anthropic-compatible Messages endpoint. Every other model goes through chat completions.

## Pooling OpenCode Go and Command Code

When both are logged in, a model that both plans serve is pooled, and selecting either id uses both subscriptions. For example, `opencode-go/kimi-k2.7-code` and `commandcode/moonshotai/Kimi-K2.7-Code` are the same pooled model. Model pickers mark these entries `pooled with …`. Ids match case-insensitively on the part after the vendor namespace, so variants such as `:free` or `-Highspeed` stay separate.

- Each conversation (main session, subagent, advisor, `/btw` thread) stays on one plan so its prompt cache keeps paying off. New conversations go to the plan with the fewest live conversations, so parallel subagents split across both. Alternating per request would miss the cache on every switch and cost more quota than it saves.
- If a plan fails a request before streaming any output, Brisk retries the same request on the other plan and the conversation stays there. This covers usage or rate limits, rejected keys, outages, and a context window that is too small. A rate-limited plan is skipped for the provider's `Retry-After` (60 seconds when absent), and a rejected key for 10 minutes. `/login` and `/logout` clear these cooldowns.
- A conversation that carries images only uses plans whose model accepts image input.
- A plan only takes conversations while it can run the exact effort resolved for the selected model. At `max`, DeepSeek V4 Flash and V4 Pro split across both plans. DeepSeek V4.1 Flash stays on OpenCode Go, because Command Code has no effort setting for it. With `auto`, every plan runs its own default and all of them share the load.
- Compaction uses the selected model's context window.

To keep a model on a single plan, log out of the other provider.

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
