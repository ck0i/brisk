# Changelog

All notable changes to Brisk are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

### Added

- Cross-platform global-install setup that idempotently persists the package manager's binary directory in Bash, Zsh, Fish, or the Windows user `PATH`.
- Maintainer-gated GitHub Actions releases on every `main` push, with automatic npm publication, `brisk-*` standalone archives, release checksums, and generated tags.
- Post-first-frame update notifications and `brisk update` support for global package installs and complete standalone release directories.
- First-class `/loop`, persistent autonomous `/goal`, and private read-only `/btw` side-thread workflows, built into the runtime and TUI rather than loaded as extensions.

### Fixed

- Recover stale terminal synchronized-output state before mounting OpenTUI, preventing blank startup after an interrupted full-screen application.
- Convert the configured whole-number compaction percentage to the context manager's ratio, preventing default startup initialization failure.
- Prebuild the npm executable with the OpenTUI Solid transform so global package launches no longer depend on the current directory containing Brisk's `bunfig.toml`.

## [0.1.0] - 2026-08-03

### Added

- Immediate-first-draw OpenTUI/Solid terminal shell with streamed assistant text, tool cards, approval and picker overlays, child-agent detail, model/context/cost footer state, cancellation, and steering.
- Owned provider-agnostic agent loop with normalized streaming events, ordered concurrent tools, retries, context-overflow recovery, usage accounting, queued turns, and deterministic fake provider.
- `@oh-my-pi/pi-ai` provider transport, cached `pi-catalog` discovery, Anthropic/OpenAI Codex/Google Antigravity/Cursor OAuth orchestration, environment API keys, and custom OpenAI-compatible completions/Responses endpoints.
- Layered JSONC global/project/CLI/runtime configuration with path-aware diagnostics, reload retention, secret-field rejection, and platform-native private data paths.
- Workspace-jailed read/search/find/list/bash tools, private full-output artifacts, process-tree cleanup, and Hashline snapshot edits with bounded diff previews, stale revalidation, atomic multi-file publication, and rollback.
- `safe`, `write`, and `yolo` permission policies with critical-operation prompting/blocking, narrow session approvals, diff UI, and known-secret redaction.
- Append-only JSONL sessions, atomic rebuildable index, interrupted/truncated transcript recovery, usage/model/compaction/child metadata, workspace resume, and session/model pickers.
- Context estimation and dynamically loaded Snapcompact archive compaction with vision frames, deterministic non-vision fallback, persisted recovery metadata, model-switch adaptation, `/context`, and `/compact`.
- Bounded context-branched research/patch subagents with immutable content-addressed checkpoints, isolated providers/sessions, cancellation/status/usage UI, recursive depth limits, and real-workspace-safe patch overlays.
- Global and approval-gated project extensions with tools, slash commands, keybindings, UI slots, lifecycle hooks, isolated failures, diagnostics, and cache-busted reload.
- `brisk doctor` installation diagnostics, a local 11-metric benchmark suite, measured performance documentation, and full fake-provider coding-session E2E coverage.
- Configurable automatic compaction, default thinking expansion, and default/high-contrast terminal shell themes.
- Host and cross-target standalone release builder for Linux x64/arm64, macOS x64/arm64, and Windows x64, including native sidecars/assets, deterministic release layout, manifests, SHA-256 checksums, and host `version` verification.
- Core provider, configuration, troubleshooting, architecture, contributing, security, release, and third-party documentation.

### Security

- Credentials are separated from project/session data and stored through private auth storage; provider/auth errors are sanitized before display or persistence.
- Configuration disallows inline provider secrets and credential-bearing endpoint URLs.
- Workspace mutations are canonicalized, staged, previewed, authorized, revalidated, and transactionally published.
- Critical destructive, workspace-escape, and likely secret-exposure operations can remain blocked even in `yolo` mode.

### Known limitations

- Automated OAuth coverage uses fake stores. Real provider grants, account entitlements, refresh behavior, and manual callback paths require the documented manual verification before release.
- Cross-compilation is not cross-platform runtime verification. All five artifacts, manifests, checksums, and binary formats are generated locally, but only the Linux x64 artifact is executed in automated release verification. The compiled Linux executables target glibc; both glibc and musl OpenTUI sidecars are packaged.

[Unreleased]: https://github.com/ck0i/brisk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ck0i/brisk/releases/tag/v0.1.0
