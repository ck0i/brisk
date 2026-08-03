# Providers and authentication

Brisk delegates provider transports, OAuth protocols, token refresh, and credential selection to `@oh-my-pi/pi-ai`. Brisk keeps its own agent loop, tools, sessions, and UI.

## Credential storage

OAuth grants and stored API keys are kept in the Brisk user data directory in an upstream `AuthStorage` SQLite database. Brisk creates the containing directory with mode `0700` and restricts the database to `0600` on POSIX systems. Credentials are never stored in a workspace configuration file or session transcript.

Environment variables remain the simplest API-key setup:

| Provider                    | Environment variable       |
| --------------------------- | -------------------------- |
| Anthropic API               | `ANTHROPIC_API_KEY`        |
| OpenAI API                  | `OPENAI_API_KEY`           |
| Google Gemini API           | `GEMINI_API_KEY`           |
| Anthropic OAuth override    | `ANTHROPIC_OAUTH_TOKEN`    |
| OpenAI Codex OAuth override | `OPENAI_CODEX_OAUTH_TOKEN` |
| Cursor override             | `CURSOR_ACCESS_TOKEN`      |

Set variables in the environment that launches `brisk`. Do not put secrets in project `.brisk/config.jsonc` files.

## OAuth commands

```text
brisk auth login anthropic
brisk auth login openai-codex
brisk auth login google-antigravity
brisk auth login cursor
brisk auth status
brisk auth logout <provider>
```

If no provider is supplied to `login`, Brisk prompts for one. Browser authorization is opened when the platform supports it. Some flows use a temporary localhost callback; when automatic completion is unavailable, Brisk asks for the callback URL or authorization code. Upstream refresh tokens are rotated automatically before expiry.

Logging out removes the local credential. It does not revoke the grant at the provider. Use the provider's account security page when remote revocation is required.

### Anthropic

Provider ID: `anthropic`. The upstream PKCE flow targets Claude's OAuth service and can complete through its localhost callback or pasted callback. Anthropic API keys use the same model catalog but API-key authentication.

### OpenAI Codex / ChatGPT

Provider ID: `openai-codex`. This is subscription-backed ChatGPT/Codex OAuth and is distinct from `OPENAI_API_KEY`. The browser PKCE flow uses a localhost callback; upstream also supports account-scoped catalog discovery and refresh-token rotation.

For ordinary OpenAI API billing, export `OPENAI_API_KEY` and select an `openai/...` model.

### Google Antigravity

Provider ID: `google-antigravity`. The upstream Google OAuth flow resolves or provisions the Cloud AI Companion project associated with the account. The project identifier is retained with the refreshed grant.

For ordinary Gemini API billing, export `GEMINI_API_KEY` and select a `google/...` model.

### Cursor

Provider ID: `cursor`. The upstream flow opens Cursor's authorization page and polls for completion. Cursor token polling has an upstream cancellation limitation: an in-flight poll can take a short time to observe cancellation, although Brisk discards the cancelled result.

## Models

```text
brisk models
brisk models --refresh
brisk --model provider/model
```

Brisk displays its cached catalog immediately and refreshes bundled/custom availability asynchronously. A model is available when its provider has a usable OAuth grant, API key, or an explicitly keyless custom endpoint. Brisk does not hardcode a single default model. Set `defaultModel` in configuration or select one interactively with `/model`.

## Custom OpenAI-compatible endpoints

```jsonc
{
  "providers": {
    "local-vllm": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "keyless": true,
      "models": [
        {
          "id": "my-model",
          "name": "Local model",
          "contextWindow": 131072,
          "maxOutputTokens": 32768,
          "input": ["text"],
          "toolCalling": true,
        },
      ],
    },
  },
}
```

For an authenticated endpoint, remove `keyless` and set `apiKeyEnv` to the **name** of an environment variable:

```jsonc
{
  "apiKeyEnv": "LOCAL_VLLM_API_KEY",
}
```

The secret value belongs in that environment variable, not in configuration. `baseUrl` must include the endpoint's API prefix when required. Brisk supports the OpenAI completions and Responses dialects selected by the optional `api` field.

## Manual account verification checklist

Automated tests exercise login orchestration, refresh/error handling, redaction, model caching, and storage with fake credential stores. Before a release, verify real grants manually without recording terminal transcripts containing callback URLs:

1. Start from a temporary Brisk data directory with no credentials.
2. Run `brisk auth login <provider>` for each OAuth provider listed above.
3. Confirm the browser opens and either automatic callback or pasted callback completion succeeds.
4. Run `brisk auth status`; verify only provider/account metadata is shown and no access or refresh token is printed.
5. Run `brisk models`; select one available model and send a text-only prompt.
6. Send a prompt that invokes a harmless read-only tool and verify the follow-up response.
7. Restart Brisk and verify the stored grant is reused.
8. Exercise refresh with a near-expiry test grant where the provider permits it.
9. Run `brisk auth logout <provider>` and confirm the provider becomes unavailable locally.
10. Inspect file modes on POSIX: the auth directory must be `0700` and the database `0600`.
11. Search logs, sessions, caches, and the workspace for token fragments; none should be present.

Record only pass/fail status, Brisk version, provider ID, platform, and model ID. Never record authorization codes, callback URLs, API keys, access tokens, refresh tokens, or decoded JWT contents.
