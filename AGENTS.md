# Agent instructions

Brisk: Bun/TypeScript terminal coding harness (Solid + OpenTUI). Agent loop, tools, sessions, compaction, and subagents are in-tree; `@oh-my-pi/pi-ai` is for providers/auth only.

## Where to look

- Layout and invariants: [ARCHITECTURE.md](ARCHITECTURE.md)
- Dev workflow and PR checks: [CONTRIBUTING.md](CONTRIBUTING.md)
- User config/auth: [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/PROVIDERS.md](docs/PROVIDERS.md)

## Rules for automated changes

- Preserve UI-first startup; do not add pre-mount network or full-repo scans without cause.
- Do not bypass Hashline, path jail, or permission services.
- Redact secrets; use `fake-provider` in tests.
- Validate external data at boundaries; match existing Prettier/oxlint/tsc settings.
- When docs disagree with [src/config/schema.ts](src/config/schema.ts) or runtime, fix docs to match code.

## Commands

```sh
bun install --frozen-lockfile
bun run dev -- --fake-provider .
bun run verify
```
