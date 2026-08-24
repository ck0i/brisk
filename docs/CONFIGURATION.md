# Configuration

Brisk reads **JSONC** (comments and trailing commas). Inline secrets are rejected.

## Precedence

Built-in defaults → global `config.jsonc` → project `.brisk/config.jsonc` → CLI flags → in-process overrides. Objects merge recursively; arrays and scalars replace lower layers.

`/reload` rereads files; **provider definition changes apply on the next session**. Failed reload keeps the last good in-memory config.

## Paths

| Platform | Global config                                      |
| -------- | -------------------------------------------------- |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/brisk/config.jsonc` |
| macOS    | `~/Library/Application Support/Brisk/config.jsonc` |
| Windows  | `%APPDATA%\Brisk\config.jsonc`                     |

Project file: `<workspace>/.brisk/config.jsonc`.

**Data** (sessions, `auth.db`, artifacts, checkpoints): Linux `~/.local/share/brisk` (or `XDG_DATA_HOME`), macOS `~/Library/Application Support/Brisk`, Windows `%APPDATA%\Brisk`. **Cache** (model catalog): parallel cache roots. POSIX data dirs use mode `0700` where supported.

User `AGENTS.md` lives beside global config; workspace `AGENTS.md` files override by directory depth. See [Usage](USAGE.md).

User-level MCP servers live in `mcp.json` beside the global config and are managed independently from layered project settings. See [MCP](MCP.md).

## Example

```jsonc
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "advisorModel": "openai/gpt-5-mini",
  "subtaskAdvisorModel": "openai/gpt-5-nano",
  "advisorEffort": "low",
  "permissionMode": "write",
  "maxSubagents": 3,
  "maxSubagentDepth": 1,
  "goalMaxTurns": 20,
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "keepRecentTokens": 20000,
  },
  "ui": { "theme": "default", "showThinking": false },
  "providers": {
    "local-vllm": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "keyless": true,
      "models": [
        {
          "id": "my-model",
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

| Field                                                                               | Notes                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `defaultModel`                                                                      | `provider/model`; availability depends on credentials                                           |
| `defaultSubtaskModel`                                                               | Optional child default; else inherits parent model                                              |
| `advisorModel`                                                                      | Optional tool-capable reviewer model; omitted disables the main advisor                         |
| `subtaskAdvisorModel`                                                               | Child reviewer model; omitted inherits `advisorModel`; `"off"` disables child advisors          |
| `effort`                                                                            | Main reasoning: `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`            |
| `subtaskEffort`                                                                     | Default child reasoning effort; same values as `effort`                                         |
| `advisorEffort`                                                                     | Main and subagent advisor reasoning effort; same values as `effort`                             |
| `permissionMode`                                                                    | `safe`, `write`, or prompt-free `yolo` (default `write`); hard-blocked operations remain denied |
| `maxSubagents` / `maxSubagentDepth`                                                 | Concurrency and nesting; `0` disables children                                                  |
| `goalMaxTurns`                                                                      | Optional autonomous `/goal` continuation limit; omitted means unlimited                         |
| `compaction.enabled`                                                                | Automatic main-agent, advisor, and subagent compaction (default `true`)                         |
| `compaction.thresholdPercent`                                                       | Provider-ready context percentage, excluding cache read/write counters (default `85`)           |
| `compaction.keepRecentTokens`                                                       | Recent tail target for each independent agent/advisor context (default `20000`)                 |
| `ui.theme`                                                                          | `default` or `high-contrast`                                                                    |
| `ui.showThinking`                                                                   | Expand thinking blocks by default                                                               |
| `/settings` edits global scalars interactively and reloads the runtime when closed. |

`BRISK_GOAL_MAX_TURNS` provides an environment fallback for `goalMaxTurns`; `PI_GOAL_MAX_TURNS` is also accepted for compatibility with the original extension. A JSONC value takes precedence over the environment, and `--goal-max-turns` takes precedence over both. `0` allows the kickoff turn and then pauses before the first automatic continuation.

## Advisors

Choosing `advisorModel` in `/settings` starts an isolated reviewer for the main session. The advisor receives incremental transcript updates and can verify concerns with only `read`, `search`, `find`, `list`, and `web_search`; it has no edit, write, shell, MCP, or subagent tools. Its normal assistant output is discarded. The only delivery path is a validated `advise` call.

Advice is shown as an Advisor message and persisted in the primary transcript. `nit` notes fold into the next agent step without interruption. `concern` and `blocker` notes steer a response that is currently streaming, but never cancel a tool already executing; tool-time advice is inserted immediately after that tool batch. A late concern is left for the next user turn, while a late blocker starts a corrective turn.

Every enabled subagent gets a separate advisor transport, context, and read-only tool registry. `subtaskAdvisorModel` may select a cheaper or stronger model for those reviewers; when omitted it inherits `advisorModel`. Set it to `"off"` to advise only the main session. `advisorEffort` controls the reasoning effort for main and subagent advisors independently of `effort` and `subtaskEffort`, and is clamped to each model's supported choices. Advisor model costs are included in the session cost total.

## Custom OpenAI-compatible providers

Required: `type: "openai-compatible"`, absolute `baseUrl` (no embedded credentials), `models[]` with `id`, `contextWindow`, `maxOutputTokens`, `input`, `toolCalling`. Set optional model field `reasoning` when a custom model supports it. Auth: `keyless: true` **or** `apiKeyEnv` (variable **name** only). Optional `api`: `openai-completions` (default) or `openai-responses`.

Authenticated example:

```jsonc
"providers": {
  "company-gateway": {
    "type": "openai-compatible",
    "baseUrl": "https://ai.example.net/v1",
    "apiKeyEnv": "COMPANY_AI_TOKEN",
    "models": [{ "id": "coding-model", "contextWindow": 200000, "maxOutputTokens": 32000, "input": ["text"], "toolCalling": true }],
  },
}
```

```sh
export COMPANY_AI_TOKEN='...'
brisk --model company-gateway/coding-model
```

API keys and OAuth: [Providers](PROVIDERS.md).
