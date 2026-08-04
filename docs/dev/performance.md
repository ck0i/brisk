# Performance benchmarks

Local regression fixture only—not a guarantee for every machine or workload.

```sh
bun src/main.ts bench
bun src/main.ts bench --json
```

The suite uses generated temp data (not your repo), reports schema version 1 with min/median/p95 stats, and cleans up in `finally`. Key metrics include `config.load`, `opentui.first_draw` (one-shot headless draw), session open/index, Hashline read/patch, search startup, tool dispatch, event batching, subagent checkpoint creation, and Snapcompact throughput.

**Caveats:** first-draw excludes full CLI cold start; most samples are warm; search uses ripgrep when available; Snapcompact numbers depend on fixture size.

For a full historical capture with host metadata and budget table, see git history of the former root `PERFORMANCE.md` or re-run `bench --json` on your machine.
