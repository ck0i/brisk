# Interactive usage

## Permission modes

Policy presets (not OS sandboxes): `safe` prompts for writes and shell; `write` allows workspace edits; `yolo` never prompts for tool or project-extension permissions. Operations classified as hard blocks remain denied without prompting. Override with `--permission-mode` or config `permissionMode`.

## Slash commands

| Command                   | Action                                |
| ------------------------- | ------------------------------------- |
| `/help`                   | Keys and commands                     |
| `/model [provider/model]` | Model selection, then effort          |
| `/effort [subagent]`      | Main or subagent reasoning effort     |
| `/login`, `/logout`       | OAuth in the TUI                      |
| `/new`                    | New session in this workspace         |
| `/sessions`, `/resume`    | Session picker (`Ctrl+O`)             |
| `/compact`, `/context`    | Compaction control and token estimate |
| `/agents`                 | Child agents                          |
| `/cost`                   | Session cost                          |
| `/settings`               | Edit global runtime settings          |
| `/reload`                 | Reload JSONC config                   |
| `/clear`                  | Clear screen (transcript kept)        |
| `/quit`                   | Exit                                  |

## Keybindings

| Key                        | Action                        |
| -------------------------- | ----------------------------- |
| `Enter`                    | Submit (steers while busy)    |
| `Shift+Enter`, `Ctrl+J`, … | Newline                       |
| `Esc`                      | Abort active work             |
| `Ctrl+C`                   | Clear composer input          |
| `Ctrl+D`                   | Exit                          |
| `Ctrl+P`                   | Model picker                  |
| `Ctrl+O`                   | Session picker                |
| `A` / `S` / `D`            | Approve once / session / deny |

## AGENTS.md

Brisk injects user `AGENTS.md` (beside global config) and workspace `AGENTS.md` files (deeper paths override shallower). `/reload` rescans. Repository instructions override user defaults for their subtree.

## Tools (summary)

Workspace-jailed `read`, Hashline `edit`/`write`, `search`, `find`, `list`, and bounded `bash`. Edits use staged diffs and approval before commit. Subagents: `task` (background) and `task_status`; see [Architecture](../ARCHITECTURE.md).
