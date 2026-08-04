# OAuth release checklist

Automated tests use fake credential stores. Before each release, verify real grants manually **without** recording callbacks or tokens.

1. Empty Brisk data directory (no prior credentials).
2. `brisk auth login <provider>` for each of: `anthropic`, `openai-codex`, `google-antigravity`, `cursor`.
3. Browser or pasted callback completes.
4. `brisk auth status` — metadata only, no token values.
5. `brisk models` — pick a model, send a text prompt.
6. Prompt that triggers a harmless read-only tool; confirm follow-up.
7. Restart Brisk — grant reused.
8. Near-expiry refresh if the provider allows a test grant.
9. `brisk auth logout <provider>` — unavailable locally.
10. POSIX: auth dir `0700`, `auth.db` `0600`.
11. Search logs/sessions/workspace for token fragments — none.

Record only: pass/fail, Brisk version, provider ID, platform, model ID.
