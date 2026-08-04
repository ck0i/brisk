# Release workflow

For maintainers publishing `brisk-ai` and standalone artifacts.

1. Bump `version` in `package.json` and `VERSION` in `src/main.ts` (must match `brisk version` output).
2. Update `CHANGELOG.md`; refresh `THIRD_PARTY_NOTICES.md` if dependencies changed.
3. `bun install --frozen-lockfile`
4. `bun run typecheck && bun run lint && bun run format:check && bun test`
5. `bun run build:verify` on the **host** target only (`--verify` rejects cross-only builds).
6. `bun run build -- --all` (or explicit targets) for release directories; verify `manifest.json` and `SHA256SUMS` in each.
7. Smoke-test `version` and a real TUI run **on each target OS**—cross-compile success is not runtime proof.
8. `bun pm pack --dry-run --ignore-scripts` — confirm `brisk` bin, `src`, `docs`, licenses, README.
9. Complete [oauth-checklist.md](oauth-checklist.md) for each built-in OAuth provider (pass/fail only in notes).
10. Publish npm + standalone artifacts from the same commit; tag after artifacts match the commit.

Supported standalone targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.
