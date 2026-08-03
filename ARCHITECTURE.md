# Brisk architecture

Brisk is a Bun/TypeScript application with a deliberately small top-level entrypoint and an owned agent runtime. It uses upstream provider/catalog/auth and rendering components, but not an upstream coding-agent loop.

## Startup and command boundary

`src/main.ts` contains only version/help handling and lazy command dispatch. Metadata commands import their required service after argument parsing. Interactive startup records the process start time, imports `src/app.tsx`, and mounts OpenTUI before doing configuration, filesystem scanning, session loading, provider discovery, authentication, extension discovery, or network work.

After first draw, the TUI `initialize` callback imports `InteractiveRuntime`. Initialization proceeds in this order:

1. Validate/canonicalize the workspace and create private platform directories.
2. Merge configuration and show diagnostics.
3. Create or resume the append-only session.
4. Register coding tools and approval services.
5. Initialize the fake provider or cached provider/model services.
6. Select a model, install the agent loop/context manager, and enable subagents.

The UI remains the owner of terminal suspension, input, overlays, and shutdown. `InteractiveRuntime` coordinates services but does not render directly.

## Major modules

| Area          | Modules                    | Responsibility                                                                                                     |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CLI           | `src/cli/*`, `src/main.ts` | Strict argument parsing, provider auth/model commands, session listing, lazy dispatch.                             |
| UI            | `src/app.tsx`, `src/ui/*`  | OpenTUI/Solid tree, composer, batched streaming state, approvals, pickers, child-agent panel.                      |
| Runtime       | `src/runtime/*`            | Post-mount orchestration, session/model switching, slash commands, subagent bridge.                                |
| Agent         | `src/core/*`               | Normalized messages/events, turn queue, streaming response assembly, retry/cancel/steer behavior, tool follow-ups. |
| Providers     | `src/providers/*`          | `pi-ai` adapter, auth storage, model cache/catalog, custom endpoints, secret-safe errors.                          |
| Tools         | `src/tools/*`              | Registry, Hashline workspace, path jail, approvals, bash lifecycle, search/find/list, artifact output limiting.    |
| Sessions      | `src/sessions/*`           | Append-only codec/store, disposable atomic index, recovery, event recorder.                                        |
| Context       | `src/context/*`            | Estimation, message grouping, Snapcompact lifecycle, image/text fallback, persisted compaction.                    |
| Subagents     | `src/subagents/*`          | Immutable checkpoints, child sessions, task/result protocol, patch overlay.                                        |
| Configuration | `src/config/*`             | Platform paths, JSONC diagnostics, schema validation, layered reload.                                              |

## Agent loop

`AgentLoop` consumes a minimal provider interface that yields normalized streaming events. A submitted user message enters a FIFO turn queue. Steering enqueues the new text and aborts the current request, allowing the queue to continue without concurrent mutation of history.

For each response:

1. The context lifecycle derives a provider-ready view from full history.
2. The provider emits thinking, text, tool-call fragments, usage, completion, or normalized errors.
3. The loop assembles exactly one assistant message and appends it to full history.
4. `ToolRegistry` validates and executes tool calls. Parallel-safe calls may run concurrently while result ordering remains call ordering.
5. Tool results are appended and another provider response runs until no tool calls remain.

Retryable failures are retried only before response deltas. A context-overflow error can force one compaction and one retry. Cancellation is represented as an abort and published to subscribers. Tool execution failure rolls history back to before the assistant/tool-call batch so incomplete tool transactions are not retained as completed context.

`AgentUiController` maps events to UI messages/cards. `AgentSessionRecorder` independently subscribes to the same event stream and serializes incremental transcript entries. Neither provider code nor the loop depends on OpenTUI.

## Providers and models

`ProviderService` owns:

- a private `AuthService` backed by upstream `AuthStorage` at Brisk's data path;
- `ModelRegistry`, which presents cached records immediately and refreshes bundled/custom records asynchronously;
- the selected `PiAiProvider` transport and session ID;
- isolated provider creation for child sessions.

`PiAiProvider` converts Brisk messages/tools into `@oh-my-pi/pi-ai` types and normalizes its stream back into Brisk events. Custom OpenAI-compatible definitions are converted into catalog records with an explicit dialect and an environment-variable credential reference. Provider-specific OAuth, refresh, and API transport code stays upstream. Error redaction happens at the provider/auth boundary before an error reaches the UI or transcript.

The model record supplies provider/API/model identity, context window, output limit, supported input modalities, and availability. Switching model updates the provider, agent loop, context model, UI metadata, and session transcript.

## Tools, transactions, and permissions

`ToolRegistry` is the schema/dispatch boundary. Coding tools share three services:

- `ArtifactStore` writes bounded private output and returns `artifact://` references.
- `HashlineWorkspace` owns snapshots and staged file transactions.
- `PermissionManager` classifies requests and mediates UI approvals.

Read paths are canonicalized; write/delete targets must remain inside the workspace. Hashline reads record normalized UTF-8 snapshots and line visibility. Edit/write operations mutate a virtual transactional filesystem first. Brisk creates a bounded unified diff, requests authorization, revalidates path topology and original bytes, then publishes. A multi-file publication failure attempts reverse-order rollback.

Permission policy has two layers. Mode policy decides which ordinary operations are automatic; critical classification can still prompt or block. Approval-equivalence keys are narrow hashes over operation details. Known environment secret values are redacted before requests are rendered.

Bash uses argument-free shell command text in a caller-selected jailed working directory, streams bounded output, persists oversized output as an artifact, and tracks process trees for timeout, cancellation, and shutdown cleanup.

## Persistence and recovery

A session transcript is an append-only, sequence-numbered JSONL file. The first record is metadata; later records capture user messages, assistant stream fragments/final messages, tool results, usage, compaction, model changes, child references, cancellation, and errors. Writes for a session are serialized. The default flush policy fsyncs when the session is flushed/closed.

Loading is tolerant at record boundaries:

- malformed or invalid records produce diagnostics and are skipped;
- non-monotonic sequences are ignored;
- an unterminated final line is copied to a private recovery file, then ignored;
- an assistant stream lacking a final assistant message is reconstructed only for diagnostics.

The session index is derived state. `SessionIndex` writes it atomically and can rebuild it from transcripts. Provider context uses only complete normalized messages, never partial display recovery.

## Context and Snapcompact

Full transcript history remains owned by `AgentLoop`; `ContextManager` derives an active provider view. It estimates text, image, tool-argument, and usage pressure and groups tool interactions so compaction does not split an assistant call from its results.

Snapcompact is dynamically imported only for a compaction pass. It summarizes the old prefix, records structured preserve data and bounded raw archive source, and retains a recent tail. Vision models can receive ordered image archive frames subject to provider/data/token budgets. A deterministic structured text archive is used otherwise. The compaction record is appended to the session before becoming active, so resume can reconstruct equivalent context. A model switch invalidates incompatible rendered frames and can rerender from preserved data.

## Subagents and patch isolation

The parent `task` tool creates a child through `RuntimeSubagents` and `SubagentManager`:

1. Prepare parent context once and capture it in `CheckpointStore` using a content-derived identity.
2. Retain the immutable checkpoint for every child in that branch.
3. Create an isolated provider/session and bounded child tool registry.
4. Run an independent `AgentLoop` until `complete_task` or a fallback result.
5. Persist the child reference and publish status/usage/transcript detail to `UiStore`.

A semaphore bounds concurrent children; depth limits block recursive task creation. Abort signals link parent and child cancellation.

Research children use workspace read/search/find/list plus policy-controlled bash. Patch children use `PatchOverlayWorkspace`: reads resolve overlay-first, edits/writes update only virtual content, and finalization produces a deterministic unified diff. Moves are represented as delete/create. The child cannot publish overlay changes to the real workspace; the parent receives the patch as result data.

## UI state and concurrency

`UiStore` is a framework-independent immutable state container. Solid components subscribe through a signal adapter. High-frequency provider/tool deltas are coalesced by the event batcher to avoid a render per token while preserving event order. Approval, picker, and child-agent overlays have exclusive key handling and promise-based controllers.

Long-lived resources have explicit ownership:

- `InteractiveRuntime` owns providers, session runtime, tools, context, and subagents.
- `AgentUiController` owns its loop subscription.
- approval/picker controllers own pending UI decisions.
- shutdown aborts active work, disposes subscriptions/children, flushes the session, closes auth storage, and cleans tracked processes.

## Security boundaries

Brisk provides application-level controls, not an OS sandbox. The enforced boundaries are:

- configuration validation and rejection of inline secrets;
- credential separation and restrictive local file modes;
- normalized provider errors with secret redaction;
- workspace canonicalization and symlink revalidation;
- staged diff approval before real mutation;
- critical-operation classification independent of permission mode;
- bounded output with private artifact retention;
- isolated child patch overlays and bounded child concurrency/depth.

Approved bash and providers retain the current user's network/filesystem privileges. Session, artifact, and checkpoint data can contain sensitive prompt/repository content and must be protected accordingly.

## Release layout

`scripts/build.ts` invokes Bun's standalone compiler with an explicit Bun target and disables runtime `.env`/`bunfig.toml` autoloading. A generated entrypoint sets an adjacent OpenTUI asset root before loading `src/main.ts`. Each clean per-target directory contains:

- deterministic `brisk` or `brisk.exe` filename;
- target OpenTUI native/parser assets;
- target `pi_natives` sidecars;
- license, notices, README, changelog, and configuration/provider/troubleshooting docs;
- `manifest.json` with package/version/target and payload hashes;
- `SHA256SUMS` over payload files and the manifest.

The host verification mode executes the artifact's `version` command and checks exact package-version output. Bun can cross-compile the supported target executables and the build provisions matching optional native packages, but runtime verification still belongs on the target operating system.
