# Repository Guidelines

## Project Overview

Brisk is a Bun/TypeScript, provider-agnostic terminal coding harness built with Solid and OpenTUI. It owns the agent loop, tool execution and permissions, append-only sessions, context compaction, and isolated subagents; `@oh-my-pi/pi-ai` supplies provider transports and authentication.

## Architecture & Data Flow

- `src/main.ts` is the lazy CLI boundary. It parses arguments, handles metadata commands, and launches the TUI without eagerly loading configuration, sessions, providers, extensions, or network state.
- `src/app.tsx` mounts OpenTUI and creates the UI store. After the first draw, `InteractiveRuntime` initializes the workspace, layered configuration, session, tools, provider/model, context manager, agent loop, subagents, and extensions.
- `AgentLoop` (`src/core/agent-loop.ts`) consumes normalized provider events through async streams. A FIFO turn queue handles user messages and steering; tool calls are validated and executed, results are appended, and the loop continues until no tool calls remain. Retryable failures and one context-overflow compaction retry are handled before completion.
- `AgentUiController` and `AgentSessionRecorder` independently subscribe to the event stream. UI events are batched into immutable `UiStore` snapshots; session events are serialized to append-only JSONL.
- Provider-specific data belongs behind `src/providers/pi-ai-provider.ts`; tool schemas/dispatch belong behind `src/tools/registry.ts`; filesystem edits go through Hashline snapshots, permission checks, staged diffs, and path-jail revalidation.
- `ContextManager` derives provider context from full history and dynamically loads Snapcompact only for compaction. `RuntimeSubagents` uses immutable checkpoints, bounded concurrency/depth, and patch overlays that cannot publish directly to the real workspace.

## Key Directories

- `src/cli/` — argument parsing and command implementations.
- `src/core/` — normalized messages/events, event batching, turn queue, streaming, retries, cancellation, and tool follow-ups.
- `src/runtime/` — post-mount orchestration, session/model switching, slash commands, subagent and extension bridges.
- `src/ui/` — OpenTUI/Solid root, immutable state adapter, controllers, composer, approvals, pickers, and child-agent views.
- `src/providers/` — `pi-ai` adapter, auth storage, model registry/cache, custom endpoints, and secret-safe errors.
- `src/tools/` — registry, coding tools, Hashline workspace, permissions, bash lifecycle, search/find/list, and bounded artifacts.
- `src/sessions/` — append-only transcript codec/repository, recovery, index, and event recorder.
- `src/context/` — token estimation, grouping, compaction lifecycle, and image/text archive fallback.
- `src/subagents/` — checkpoints, child sessions, task/result protocol, semaphores, and patch overlays.
- `src/extensions/` — discovery, validation, lifecycle, isolation, reload, and contribution registration.
- `src/config/` — platform paths, JSONC parsing/diagnostics, schema validation, layered reload, and configuration types.
- `tests/unit/`, `tests/integration/`, `tests/e2e/` — isolated logic/UI tests, runtime integration tests, and packaged CLI smoke tests.
- `scripts/` — npm bundle, standalone release, and postinstall PATH setup.
- `docs/` — configuration, provider/auth, extension, and troubleshooting details.

## Development Commands

Install the pinned graph and run the deterministic local UI:

```sh
bun install --frozen-lockfile
bun run dev -- --fake-provider .
```

Common checks:

```sh
bun run typecheck                         # tsc --noEmit
bun run lint                              # oxlint; warnings are errors
bun run format:check
bun test                                  # unit + integration discovery
bun run test:e2e                          # tests/e2e only
bun run verify                            # typecheck, lint, tests, e2e
```

Build and packaging:

```sh
bun run build                             # host standalone artifact
bun run build -- --all                    # all supported targets
bun run build:verify                      # build and verify host artifact
bun run build:package                     # npm bundle at dist/npm/brisk.js
bun run pack:check                        # bundle + npm dry-run
bun run release:check                     # release validation chain
bun run bench                             # local deterministic benchmark
bun pm pack --dry-run --ignore-scripts
```

Use `bun run build:verify` for host verification only; cross-compilation is not runtime validation for another OS.

## Code Conventions & Common Patterns

- TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, and `isolatedModules` are enabled. Avoid `any`; validate external data at boundaries with schemas or typed normalization.
- The package is ESM. Preserve explicit `.ts` imports and the existing `moduleResolution: "Bundler"` setup; no path aliases are configured.
- Format with Prettier: 2-space indentation, semicolons, double quotes, trailing commas, and 100-column width. Use lowercase comments for mechanisms/invariants rather than restating code.
- Prefer dependency injection through options/factories and small interfaces. Existing services such as `ProviderService`, `ToolRegistry`, and `SessionRepository` accept fakes/stores for tests.
- Use `AbortController`/`AbortSignal` for cancellation and cleanup. Streaming code generally uses async iterables and `for await`; long-lived resources must dispose subscriptions, child sessions, auth/providers, overlays, and tracked processes.
- Keep UI state framework-independent and immutable; Solid components subscribe through the adapter. Batch high-frequency provider/tool events instead of rendering once per token.
- Normalize provider errors at the adapter boundary and redact secrets before errors reach UI, transcripts, logs, artifacts, or tests. Never place real credentials, OAuth codes, callback URLs, or tokens in fixtures.
- Preserve append-only session history. The session index is rebuildable derived state; incomplete or corrupt final records are recovery diagnostics, not completed provider context.
- Do not bypass Hashline/path-jail/permission services. Workspace writes are staged, previewable, revalidated against original bytes/topology, and published transactionally.
- Preserve immediate first draw: filesystem scans, config/session/provider/auth/extension work belongs after TUI mount.

## Important Files

- `src/main.ts` — Bun entrypoint, version/help, lazy command dispatch, and top-level cleanup/error handling.
- `src/app.tsx` — OpenTUI mount and first-draw boundary.
- `src/runtime/interactive-runtime.ts` — service initialization and shutdown ownership.
- `src/core/agent-loop.ts` — streaming turn, retry, cancellation, compaction, and tool orchestration.
- `src/providers/provider-service.ts`, `src/providers/pi-ai-provider.ts` — model/auth lifecycle and provider normalization.
- `src/tools/registry.ts`, `src/tools/coding-tools.ts`, `src/tools/approval.ts` — tool dispatch, workspace tools, and permission policy.
- `src/sessions/repository.ts` and `src/context/context-manager.ts` — persistence/recovery and derived provider context.
- `src/ui/state.ts`, `src/ui/agent-controller.ts` — immutable UI state and event-to-view mapping.
- `src/config/load.ts`, `src/config/schema.ts` — layered configuration and validation.
- `src/providers/fake-provider.ts` — deterministic scripted provider used by tests and local development.
- `ARCHITECTURE.md` — detailed lifecycle, invariants, release layout, and security boundaries.
- `CONTRIBUTING.md` — validation, release, OAuth, and change constraints.
- `package.json`, `tsconfig.json`, `bunfig.toml`, `.prettierrc.json` — scripts and tool configuration.

## Runtime/Tooling Preferences

- Use Bun `>=1.3.14`; the repository pins `bun@1.3.14` in `package.json` and `bun.lock`. Node alone is not supported.
- Install with `bun install --frozen-lockfile`; do not float the pinned OpenTUI or `@oh-my-pi` stack. `@oh-my-pi/pi-natives` is a trusted dependency and native OpenTUI assets may be required for UI/build tests.
- `bunfig.toml` preloads `@opentui/solid/preload` for runtime and tests. `tsconfig.json` uses ES2024, preserved JSX with `@opentui/solid`, Bun types, and no emit.
- `scripts/build-package.ts` emits the npm bundle at `dist/npm/brisk.js`; `scripts/build.ts` emits standalone target directories with native assets, `manifest.json`, and `SHA256SUMS`. `dist/` is generated and ignored.
- Standalone builds disable Bun `.env`/`bunfig.toml` autoloading and set the adjacent OpenTUI asset root. Keep release directories intact; do not separate the executable from `assets/` or `pi_natives`.
- No repository CI workflow, Docker/devcontainer configuration, or coverage runner/threshold is present. Validate locally with the documented Bun commands.

## Testing & QA

- Test files use `*.test.ts`/`*.test.tsx` with `bun:test`. Unit tests cover config, CLI, providers/auth, tools, sessions, Hashline/patch overlays, UI, state, batching, and the fake provider. Integration tests cover the agent loop, context/session runtime, extensions, subagents, coding tools, provider services, and UI controller.
- Use `src/providers/fake-provider.ts` and handwritten recording fakes/stores. Do not use real provider credentials or network access in automated tests.
- Filesystem tests should create `mkdtemp` roots, track all temporary paths, and remove them in `afterEach` or `finally`. Auth/subprocess tests use temporary XDG directories and restore environment mutations.
- OpenTUI tests use deterministic `testRender`, dimensions, `mockInput`, frame assertions, and `finally` renderer cleanup. No snapshot convention is established.
- The e2e suite exercises a temporary coding workspace, approvals, Hashline edits, transcript/resume behavior, and a packaged `bench --json` subprocess with `NO_COLOR=1` and a bounded timeout.
- For behavioral changes, add focused coverage—especially for persistence, permissions, transactions, compaction, cancellation, and recovery—and run the smallest relevant test first, then `bun run verify` before handoff.
- Real OAuth/browser callbacks, account access, native target execution, and cross-platform TUI behavior require manual verification; automated fake-provider tests do not prove them.

When documentation conflicts, check implementation and schema behavior before changing it. In particular, `docs/CONFIGURATION.md` currently describes `compaction.enabled` and UI settings as active while `docs/TROUBLESHOOTING.md` calls them reserved in 0.1.0; treat this as a known documentation inconsistency to resolve with source evidence.
