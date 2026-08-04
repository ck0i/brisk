# Release workflow

For maintainers publishing `brisk-ai` and standalone artifacts.

## Automatic releases

A push to `main` by an actor with GitHub `write`, `maintain`, or `admin` permission runs [the release workflow](../../.github/workflows/release.yml). The workflow:

1. Adds the workflow run number to the patch component in `package.json` (for example, base `0.1.0` at run 12 becomes `0.1.12`).
2. Runs `bun run release:check` and builds all standalone targets.
3. Publishes the generated version of `brisk-ai` to npm. Store `NPM_TOKEN` as a secret in the repository's `main` environment; the workflow selects that environment for the release job.
4. Creates and pushes a release-only version commit and `v<version>` tag without changing `main`.
5. Publishes a GitHub release with generated notes, all archives, and `brisk-release-SHA256SUMS`.

The permission check is intentional: pushes made by automation or actors without maintainer access cannot publish. Releases are serialized so two quick pushes cannot race.

Published standalone archives are:

- `brisk-linux-x64.tar.gz`
- `brisk-linux-arm64.tar.gz`
- `brisk-darwin-x64.tar.gz`
- `brisk-darwin-arm64.tar.gz`
- `brisk-windows-x64.tar.gz`

The corresponding Bun compilation targets remain an internal build detail. Extracted directories and release manifests use the `brisk-*` names.

## Before pushing

1. Update `CHANGELOG.md`; refresh `THIRD_PARTY_NOTICES.md` if dependencies changed.
2. Run `bun install --frozen-lockfile`.
3. Run `bun run verify` and `bun run release:check`.
4. Complete [oauth-checklist.md](oauth-checklist.md) for each built-in OAuth provider (pass/fail only in notes).
5. When practical, smoke-test `brisk version`, `brisk update`, and a real TUI run on each target OS. Cross-compilation success is not runtime proof.

Bump the base version in `package.json` when starting a new major or minor release line. `src/version.ts` reads that package version, so source, npm bundles, and compiled artifacts cannot drift.
