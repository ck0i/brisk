# Configuration

Brisk reads JSONC: comments and trailing commas are accepted. Inline secrets are not.

## Precedence

Layers are merged in this order, from lowest to highest priority:

1. Built-in defaults
2. Global `config.jsonc`
3. Project `.brisk/config.jsonc`
4. CLI overrides such as `--model` and `--permission-mode`
5. In-process runtime overrides

Objects merge recursively. Arrays and scalar values replace the lower layer. Project configuration is resolved from the canonical workspace selected at startup. `/reload` rereads file layers; provider-definition changes are intentionally deferred until the next session initialization. A failed reload does not replace the last valid in-memory configuration.

Unknown fields produce warnings and are ignored. Type/range errors, JSONC syntax errors, inline secret-like provider fields, and endpoint URLs containing user information are fatal. Diagnostics include the source file and JSON path.

## Configuration paths

| Platform | Global configuration                               | Project configuration             |
| -------- | -------------------------------------------------- | --------------------------------- |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/brisk/config.jsonc` | `<workspace>/.brisk/config.jsonc` |
| macOS    | `~/Library/Application Support/Brisk/config.jsonc` | `<workspace>/.brisk/config.jsonc` |
| Windows  | `%APPDATA%\Brisk\config.jsonc`                     | `<workspace>\.brisk\config.jsonc` |

Linux uses `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` only when they are absolute; otherwise it uses the standard home-directory defaults. Windows similarly requires absolute `APPDATA` and `LOCALAPPDATA` values.

Related state locations:

| State                   | Linux                                    | macOS                                 | Windows                      |
| ----------------------- | ---------------------------------------- | ------------------------------------- | ---------------------------- |
| Data root               | `${XDG_DATA_HOME:-~/.local/share}/brisk` | `~/Library/Application Support/Brisk` | `%APPDATA%\Brisk`            |
| Cache root              | `${XDG_CACHE_HOME:-~/.cache}/brisk`      | `~/Library/Caches/Brisk`              | `%LOCALAPPDATA%\Brisk\Cache` |
| Sessions                | `<data>/sessions/*.jsonl`                | same                                  | same                         |
| Session index           | `<data>/session-index.json`              | same                                  | same                         |
| Artifacts               | `<data>/artifacts`                       | same                                  | same                         |
| OAuth/API auth database | `<data>/auth.db`                         | same                                  | same                         |
| Model cache             | `<cache>/models.json`                    | same                                  | same                         |
| Subagent checkpoints    | `<data>/checkpoints`                     | same                                  | same                         |

Brisk creates private data directories with mode `0700` and sensitive files with mode `0600` on POSIX systems. Windows access is governed by the account's ACLs.

## Full example

```jsonc
{
  // provider/model; omit to select interactively
  "defaultModel": "anthropic/claude-sonnet-4-5",

  // safe | write | yolo
  "permissionMode": "write",

  // zero disables child-agent creation in the interactive runtime
  "maxSubagents": 3,
  "maxSubagentDepth": 1,

  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "keepRecentTokens": 20000,
  },

  "ui": {
    "theme": "default",
    "showThinking": false,
  },

  "providers": {
    "local-vllm": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "keyless": true,
      "api": "openai-completions",
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

## Fields

### Model and permissions

- `defaultModel`: non-empty `provider/model` string used for initial selection. Availability is still checked against credentials and the catalog.
- `permissionMode`: `safe`, `write`, or `yolo`; default `write`. See the security section in the README. CLI `--permission-mode` has higher precedence.

### Subagents

- `maxSubagents`: non-negative integer; default `3`. It is the maximum number of concurrently running children. `0` disables interactive subagent setup.
- `maxSubagentDepth`: non-negative integer; default `1`. Root tasks are depth zero, so the default allows one child level. `0` disables interactive subagent setup.

Children branch from an immutable prepared-context checkpoint. Research children have read/search/find/list/bash tools. Patch children mutate an isolated overlay and return a diff rather than writing the workspace.

### Compaction

- `compaction.thresholdPercent`: integer `1` through `100`; default `85`. Automatic compaction starts at this percentage of a known context window.
- `compaction.keepRecentTokens`: non-negative integer; default `20000`. Approximate recent-history target retained after an ordinary compaction. Overflow recovery uses a smaller target.
- `compaction.enabled`: enables threshold-triggered automatic compaction; default `true`. Setting it to `false` retains explicit `/compact` and the one-shot overflow recovery path.

A model with an unknown context window has no automatic threshold. `/compact` remains available. Snapcompact is loaded only when a compaction pass runs. Vision-capable models may receive rendered archive frames; other models receive deterministic text fallback.

### UI

- `ui.theme`: `default` or `high-contrast`; default `default`.
- `ui.showThinking`: expands thinking blocks by default when `true`; default `false`. Tab can still collapse or expand the latest block.

Both fields apply on startup and `/reload`.

## Custom OpenAI-compatible providers

Every custom provider requires:

- `type`: exactly `openai-compatible`.
- `baseUrl`: an absolute URL with no embedded username or password. Include the service's API prefix, commonly `/v1`.
- `models`: at least one model record.
- Authentication through exactly the intended route: `keyless: true`, or `apiKeyEnv` naming an environment variable available to Brisk.

Optional `api` selects `openai-completions` (the default) or `openai-responses`.

A model record contains:

- `id`: non-empty endpoint model ID.
- `name`: optional display name.
- `contextWindow`: positive integer.
- `maxOutputTokens`: positive integer.
- `input`: non-empty array containing `text` and optionally `image`.
- `toolCalling`: boolean.

Authenticated example:

```jsonc
{
  "providers": {
    "company-gateway": {
      "type": "openai-compatible",
      "baseUrl": "https://ai.example.net/v1",
      "apiKeyEnv": "COMPANY_AI_TOKEN",
      "api": "openai-responses",
      "models": [
        {
          "id": "coding-model",
          "contextWindow": 200000,
          "maxOutputTokens": 32000,
          "input": ["text", "image"],
          "toolCalling": true,
        },
      ],
    },
  },
}
```

Launch with the secret in the environment, not the JSONC file:

```sh
export COMPANY_AI_TOKEN='...'
brisk --model company-gateway/coding-model
```

Brisk rejects provider fields named like `apiKey`, `token`, `accessToken`, `secret`, `password`, or `authorization`, including common dash/underscore variants. `apiKeyEnv` stores only the variable name.

## Credential configuration

Ordinary provider API keys are resolved through `@oh-my-pi/pi-ai` environment mappings. At minimum, common providers use:

| Provider path               | Environment variable       |
| --------------------------- | -------------------------- |
| Anthropic API               | `ANTHROPIC_API_KEY`        |
| OpenAI API                  | `OPENAI_API_KEY`           |
| Google Gemini API           | `GEMINI_API_KEY`           |
| Anthropic OAuth override    | `ANTHROPIC_OAUTH_TOKEN`    |
| OpenAI Codex OAuth override | `OPENAI_CODEX_OAUTH_TOKEN` |
| Cursor override             | `CURSOR_ACCESS_TOKEN`      |

`brisk auth status` shows all provider environment mappings recognized by the installed catalog and which are configured, without revealing values. Brisk has no CLI that writes a raw API key into configuration. OAuth login writes a grant to `auth.db`; custom endpoint keys stay in their named environment variables.

See [Providers and authentication](PROVIDERS.md) for OAuth commands, API/OAuth distinctions, and the mandatory manual account-verification caveat.
