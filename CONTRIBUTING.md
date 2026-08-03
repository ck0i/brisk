# Contributing to Brisk

## Requirements

- Bun 1.3.14 or newer
- Git
- A supported native development host: Linux x64/arm64, macOS x64/arm64, or Windows x64

Install the pinned dependency graph:

```sh
bun install --frozen-lockfile
```

Do not substitute floating package versions for the pinned OpenTUI and `@oh-my-pi` stack. Their provider types, Solid transform, and native assets must remain mutually compatible.

## Development

Run the TUI against the deterministic provider when provider credentials are unnecessary:

```sh
bun run dev -- --fake-provider .
```

Useful commands:

```sh
bun run typecheck
bun run lint
bun run format:check
bun test
bun run bench
bun run build:verify
bun pm pack --dry-run --ignore-scripts
```

`bun run format` writes Prettier changes. Tests are organized under `tests/unit` and `tests/integration`; `test:e2e` is a separate script. Add focused coverage when changing existing behavior or a high-risk persistence, permission, transaction, compaction, or cancellation path.

## Design constraints

Keep changes consistent with [ARCHITECTURE.md](ARCHITECTURE.md):

- Preserve immediate first draw. New repository scans, extension loading, provider/catalog setup, auth work, session IO, and network requests belong after UI mount.
- Keep Brisk's agent loop provider-agnostic. Provider-specific messages and exceptions must be normalized at the adapter boundary.
- Do not expose secret values in configuration, errors, sessions, caches, logs, artifacts, approval prompts, or fixtures.
- Keep workspace changes previewable, revalidated, and transactional. Do not bypass Hashline/path-jail/permission services.
- Append session records; do not rewrite transcript history in place. Treat the index as rebuildable derived state.
- Preserve cancellation ownership and dispose subscriptions, provider/auth resources, process trees, overlays, and child sessions.
- Keep subagent checkpoints immutable and patch children isolated from the real workspace.
- Prefer the smallest complete change. Avoid broad abstractions or unrelated refactors.

TypeScript is strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`. Avoid `any`; validate data at external boundaries. Use lowercase comments that explain mechanism or invariant rather than restating code.

## Validation

Before opening a change, run:

```sh
bun run typecheck
bun run lint
bun run format:check
bun test
```

For package/release changes also run:

```sh
bun run build:verify
bun pm pack --dry-run --ignore-scripts
```

`build:verify` cleans and creates only the host release directory, computes its hashes, then runs `brisk version`. It does not validate TUI rendering, native loading, provider access, OAuth grants, or cross-platform execution. Test changed interactive behavior in a real terminal, and test cross artifacts on their target systems.

When reporting validation, distinguish commands actually run from expected behavior. Do not claim a provider/account/platform was exercised when it was only compiled or covered with a fake.

## Release workflow

1. Update `version` in `package.json` and the `VERSION` constant in `src/main.ts`; they must produce exact `brisk <version>` output.
2. Update `CHANGELOG.md` and, when dependencies change, `THIRD_PARTY_NOTICES.md` from installed package metadata/license files.
3. Run `bun install --frozen-lockfile` and the full validation commands above.
4. Run `bun run build:verify` on the host.
5. Run `bun run build -- --all` to create the five supported target directories, or pass explicit target names. Cross-compilation may download target Bun runtimes and optional native packages.
6. Verify `manifest.json` and `SHA256SUMS` in every directory. Execute `version` and a real TUI smoke run on each target operating system. A successful cross compile is not runtime verification.
7. Run `bun pm pack --dry-run --ignore-scripts`. Confirm the tarball exposes `brisk`, includes `src`, `docs`, license/notices, architecture, changelog, contributing guide, and README, and excludes development/output state.
8. Complete the real-account OAuth checklist in `docs/PROVIDERS.md` for each supported built-in OAuth provider. Record only pass/fail, Brisk version, provider/model ID, and platform.
9. Publish the npm package and standalone directories/checksums from the same commit. Tag only after the artifacts and changelog match that commit.

The build's `--verify` mode intentionally rejects cross-only selections because a host cannot establish that another platform's executable works. Native release assets are provisioned for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, and `bun-windows-x64`; other target strings fail before output is produced.

## OAuth changes

Automated auth tests must use fake credential stores and sanitized values. Never place real callback URLs, authorization codes, API keys, access tokens, refresh tokens, cookies, or decoded JWT contents in a test, issue, commit, recording, or CI log.

Provider OAuth behavior is time-sensitive and account-specific. In addition to tests:

- verify browser launch and manual callback/code fallback;
- verify refresh and restart reuse;
- confirm `auth status` does not print credentials;
- confirm logout removes local state and document separate remote revocation;
- inspect POSIX auth directory/database modes;
- search generated logs, sessions, caches, and the workspace for test token fragments.

## Commits and review

Keep commits focused and describe the observable behavior or invariant. Include:

- concrete failure/impact when fixing a bug;
- configuration/session schema implications;
- security-boundary changes;
- commands and platforms actually validated;
- remaining target-specific uncertainty.

Avoid committing credentials, local `.brisk/` state, `.env` files, `dist/`, coverage, logs, temporary recovery files, or generated package tarballs.
