# Interactive usage

## Permission modes

Policy presets (not OS sandboxes): `safe` prompts for writes and shell; `write` allows workspace edits; `yolo` never prompts for tool or project-extension permissions. Operations classified as hard blocks remain denied without prompting. Override with `--permission-mode` or config `permissionMode`.

## Slash commands

| Command                            | Action                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `/help`                            | Keys and commands                                                       |
| `/model [provider/model]`          | Model selection, then effort                                            |
| `/effort [subagent]`               | Main or subagent reasoning effort                                       |
| `/loop [N]`, `status`, `stop`      | Repeat the next prompt `N` times, or indefinitely when `N` is omitted   |
| `/goal <objective>`                | Start an autonomous, persistent session goal                            |
| `/goal show`, `pause`, `resume`, … | Inspect or control the active goal (`drop` abandons it)                 |
| `/btw <question>`                  | Open a private read-only side thread while the main agent keeps running |
| `/login`, `/logout`                | OAuth in the TUI                                                        |
| `/new`                             | New session in this workspace                                           |
| `/sessions`, `/resume`             | Session picker (`Ctrl+O`)                                               |
| `/compact`, `/context`             | Compaction control and token estimate                                   |
| `/agents`                          | Child agents                                                            |
| `/cost`                            | Session cost                                                            |
| `/settings`                        | Edit global runtime settings                                            |
| `/reload`                          | Reload JSONC config                                                     |
| `/clear`                           | Clear screen (transcript kept)                                          |
| `/quit`                            | Exit                                                                    |

`/loop` captures the next accepted prompt and repeats it only after each full agent run settles; cancellation or provider failure stops the loop. `/goal` persists its full objective in the session, gives the model a `goal` completion tool, and automatically continues until completed, dropped, paused, or limited by `goalMaxTurns`. `/btw` copies a safe snapshot of the main context into an isolated side agent with only `read`, `search`, `find`, and `list`; its conversation is not inserted into the main transcript. Press `Esc` to close the BTW overlay.

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
