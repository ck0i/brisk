# Contributing

## Setup

- Bun **1.3.14+**, Git
- `bun install --frozen-lockfile` — do not float the pinned OpenTUI / `@oh-my-pi` stack

```sh
bun run dev -- --fake-provider .
```

## Checks

Before opening a PR:

```sh
bun run typecheck
bun run lint
bun run format:check
bun test
```

Full gate: `bun run verify` (adds e2e). Use `bun run format` to apply Prettier.

Tests live under `tests/unit`, `tests/integration`, and `tests/e2e`. Prefer `fake-provider` and temp directories; never commit credentials or local `dist/`.

## Design constraints

Align with [ARCHITECTURE.md](ARCHITECTURE.md):

- UI mounts before heavy I/O and network setup.
- Normalize provider behavior at the adapter; keep the loop provider-agnostic.
- No secrets in config, logs, sessions, or fixtures.
- Workspace mutations go through Hashline + permissions; sessions are append-only.
- Dispose subscriptions, processes, and child sessions on shutdown.

TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.). ESM with explicit `.ts` imports; no path aliases.

## Pull requests

Describe observable behavior, schema or security impact, and commands you actually ran. Focused commits; no unrelated refactors.

## Maintainers

Release and OAuth verification: [docs/dev/releasing.md](docs/dev/releasing.md). Benchmark notes: [docs/dev/performance.md](docs/dev/performance.md).
