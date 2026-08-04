# Architecture

Bun/TypeScript app with a thin `src/main.ts` entrypoint and an owned agent runtime. Upstream packages supply provider transport, catalog, and UI primitives—not the coding-agent loop.

## Startup

1. `main.ts` — version/help/update and lazy command dispatch.
2. `app.tsx` — mount OpenTUI **before** config, sessions, providers, auth, extensions, or network.
3. Post-first-frame initialization starts the non-blocking release check and `InteractiveRuntime` setup.
4. `InteractiveRuntime` — workspace, config, `AGENTS.md`, session, tools, provider/model, `AgentLoop`, context, subagents, extensions.

The UI owns terminal I/O and shutdown; runtime coordinates services.

## Modules

| Area       | Path                     | Role                                                                                   |
| ---------- | ------------------------ | -------------------------------------------------------------------------------------- |
| CLI        | `src/cli/`, `main.ts`    | Args, auth/models/sessions, lazy dispatch                                              |
| UI         | `src/app.tsx`, `src/ui/` | Solid/OpenTUI, composer, approvals, pickers                                            |
| Runtime    | `src/runtime/`           | Slash commands, first-class loop/goal/BTW modes, session/model switch, subagent bridge |
| Agent      | `src/core/`              | Messages/events, turn queue, streaming, tools, retries                                 |
| Providers  | `src/providers/`         | `pi-ai` adapter, auth, model cache, custom endpoints                                   |
| Tools      | `src/tools/`             | Registry, Hashline workspace, permissions, bash                                        |
| Sessions   | `src/sessions/`          | Append-only JSONL, index, recovery                                                     |
| Context    | `src/context/`           | Estimation, Snapcompact (dynamic import)                                               |
| Subagents  | `src/subagents/`         | Checkpoints, child sessions, patch overlay                                             |
| Extensions | `src/extensions/`        | Discovery, contributions, reload                                                       |
| Config     | `src/config/`            | JSONC layers, schema, paths                                                            |
| Updates    | `src/update/`            | Validated GitHub releases and semantic version checks                                  |

## Agent loop

`AgentLoop` streams normalized provider events. User input uses a FIFO queue; steering aborts the in-flight request. Each turn: derive context → system prompt + `AGENTS.md` + tools → provider response → tool execution (validated via `ToolRegistry`) → repeat until no tool calls. Failed tool batches roll back incomplete assistant/tool state. One forced compaction retry on context overflow.

`AgentUiController` and `AgentSessionRecorder` subscribe independently; neither depends on OpenTUI.

First-class modes are coordinated by the runtime rather than extension hooks: `/loop` resubmits a captured prompt after root-loop idle events; `/goal` persists mode state in session JSONL, injects a fresh objective reminder, and owns the built-in `goal` tool; `/btw` runs a non-persistent isolated provider loop with a read-only tool registry and its own TUI overlay.

## Providers

`ProviderService` wraps auth storage, `ModelRegistry`, and `PiAiProvider`. Provider-specific shapes are normalized at the adapter. Reasoning effort is resolved against each model's catalog-declared levels and applied independently to main and isolated child transports. Custom OpenAI-compatible providers use catalog records + `apiKeyEnv` or `keyless`. Errors are redacted before UI/transcript.

## Tools and permissions

`HashlineWorkspace` stages edits; `PermissionManager` and mode policy gate execution. Bash is jailed, bounded, and process-tracked. Artifacts live under private `artifact://` storage.

## Persistence

Append-only session JSONL; index is rebuildable. Partial final lines and incomplete assistant streams are recovery diagnostics only—not provider context.

## Context

Full history stays in `AgentLoop`; `ContextManager` builds the active provider view and runs Snapcompact on threshold, `/compact`, or overflow recovery.

## Subagents and patch isolation

`task` captures an immutable checkpoint, runs a child `AgentLoop`, returns immediately. Research children use read/search tools; patch children edit a **virtual overlay** and return a unified diff (never auto-applied to the workspace). Concurrency and depth are config-bounded.

## Security (application-level)

Config rejects inline secrets; workspace paths are canonicalized; writes are previewed and revalidated; approvals redact known env secrets. Not an OS sandbox—review diffs and use `safe` on untrusted trees.

## Packaging

npm bundle: `scripts/build-package.ts` → `dist/npm/brisk.js`. Standalone: `scripts/build.ts` → `dist/brisk-<platform>-<arch>` with bundled assets and checksums. Maintainer automation: [docs/dev/releasing.md](docs/dev/releasing.md).
