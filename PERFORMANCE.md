# Performance

This document records one local benchmark run. It is a reproducible fixture result, not a claim about every repository, filesystem, terminal, or machine. No before/after comparison is available or implied.

## Reference host

Measurements were captured on 2026-08-03 at `2026-08-03T22:04:25.434Z`.

| Property             | Observed value                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Host                 | `nick-pc`                                                                                                        |
| OS                   | CachyOS rolling release                                                                                          |
| Kernel               | Linux `7.1.2-3-cachyos-nika`, x86_64                                                                             |
| CPU                  | 13th Gen Intel Core i9-13900K, 24 physical cores, 32 logical CPUs, up to 5.8 GHz                                 |
| Cache                | 896 KiB L1d, 1.3 MiB L1i, 32 MiB L2, 36 MiB L3                                                                   |
| Memory               | 67,178,979,328 bytes total, approximately 62.6 GiB                                                               |
| Bun                  | `1.3.14`; binary revision `1.3.14-canary.1+0d9b296af`                                                            |
| ripgrep              | `15.2.0`, AVX2 runtime, PCRE2 10.45 with JIT                                                                     |
| Terminal environment | `TERM=xterm-kitty`, `COLORTERM=truecolor`; benchmark process stdin was not a TTY, so dimensions were unavailable |

The host was not isolated. Frequency scaling, turbo state, scheduler placement, background work, page cache, and thermal state were not controlled. At metadata capture, `lscpu` reported CPU scaling at 87%, and the machine had active swap use.

## Running the suite

```sh
bun src/main.ts bench
bun src/main.ts bench --json
```

Both commands are local and perform no network requests. The JSON form has schema version 1 and reports units, sample counts, warmups, operations per sample, workload details, and min/median/mean/nearest-rank-p95/max statistics.

The benchmark creates generated data beneath one private OS temporary directory and removes that directory in a `finally` block. It does not use current-repository contents as fixture input or read user configuration, sessions, credentials, or caches; normal execution still loads Brisk and dependency modules.

## Methodology

- Timing uses `process.hrtime.bigint()`.
- Repeatable metrics discard 2 warmups and record 7 samples.
- OpenTUI first draw is intentionally a one-shot measurement with no warmup. It includes dynamic import of the OpenTUI/Solid UI module, creation of Brisk's root view, and one 100x30 headless draw.
- ToolRegistry samples contain 50 dispatches and report normalized time per dispatch.
- Child creation samples contain 20 in-memory checkpoint/session pairs and report normalized time per pair.
- Event latency primes `EventBatcher`, queues an event immediately after that flush, and measures until the configured 16 ms frame consumes it.
- Hashline patch setup reads the current generated file before the timer. The measured region includes patch parsing, staging, diff generation, stale-content revalidation, and atomic commit of one changed line.
- Search runs a no-match query against one generated file. This host selected ripgrep; systems without ripgrep measure the filesystem fallback and are not directly comparable.
- Snapcompact imports before measurement, uses 2 warmups, varies a fixed-width marker between passes, and measures local serialization, normalization, layout, native rasterization, and PNG encoding for 73,056 generated source characters into at most one frame.
- The session-index fixture contains 24 generated records. Session open reconstructs 160 generated messages. Hashline read formats a 28,672-byte, 512-line generated file.
- Suite setup and temporary-directory removal are included in the reported total duration but not in individual metric timings.

## Measured result

This is the canonical `brisk bench --json` run used by this document.

| Metric                              |    Unit | Samples | Warmups | Ops/sample |              Min |           Median |             Mean |              P95 |              Max |
| ----------------------------------- | ------: | ------: | ------: | ---------: | ---------------: | ---------------: | ---------------: | ---------------: | ---------------: |
| `config.load`                       |      ms |       7 |       2 |          1 |         0.185397 |         0.267895 |         0.273576 |         0.363521 |         0.363521 |
| `opentui.first_draw`                |      ms |       1 |       0 |          1 |       358.193552 |       358.193552 |       358.193552 |       358.193552 |       358.193552 |
| `sessions.index_load`               |      ms |       7 |       2 |          1 |         0.226777 |         0.247461 |         0.264432 |         0.337444 |         0.337444 |
| `sessions.open`                     |      ms |       7 |       2 |          1 |         0.357168 |         0.646286 |         0.648937 |         0.840645 |         0.840645 |
| `hashline.read_format`              |      ms |       7 |       2 |          1 |         0.915731 |         1.139342 |         1.340354 |         2.792162 |         2.792162 |
| `hashline.patch_apply`              |      ms |       7 |       2 |          1 |         2.116838 |         2.752917 |         2.965428 |         4.403059 |         4.403059 |
| `search.startup`                    |      ms |       7 |       2 |          1 |         1.750886 |         2.071849 |         2.302061 |         4.165956 |         4.165956 |
| `tools.registry_dispatch`           |      us |       7 |       2 |         50 |         8.580920 |        10.326420 |        10.004449 |        12.242800 |        12.242800 |
| `events.event_to_render`            |      ms |       7 |       2 |          1 |        15.040222 |        15.097966 |        15.476437 |        16.183682 |        16.183682 |
| `subagents.checkpoint_child_create` |      us |       7 |       2 |         20 |        43.756100 |        49.490800 |        59.272814 |        95.433250 |        95.433250 |
| `snapcompact.throughput`            | chars/s |       7 |       2 |          1 | 2,255,748.095779 | 4,110,956.433799 | 3,811,676.289987 | 4,348,157.835939 | 4,348,157.835939 |

Total suite duration was 960.436 ms. Workload-specific details were: 2 configuration layers; a 24-record cached session index; a 160-message transcript; a 28,672-byte Hashline source; one atomically changed line; ripgrep over one file; a 16 ms event frame; a 24-message in-memory checkpoint; and one Snapcompact frame.

## Regression budgets

These are provisional engineering budgets for this exact generated fixture. They are not end-user latency guarantees, and they should be revisited when fixture shape or implementation semantics change. Latency budgets use P95 except for the one-shot first draw; throughput uses the median.

| Metric                              |                    Budget | Observed budget statistic | Result |
| ----------------------------------- | ------------------------: | ------------------------: | ------ |
| `config.load`                       |               P95 <= 5 ms |               0.363521 ms | within |
| `opentui.first_draw`                |        one shot <= 500 ms |             358.193552 ms | within |
| `sessions.index_load`               |               P95 <= 5 ms |               0.337444 ms | within |
| `sessions.open`                     |              P95 <= 10 ms |               0.840645 ms | within |
| `hashline.read_format`              |              P95 <= 10 ms |               2.792162 ms | within |
| `hashline.patch_apply`              |              P95 <= 25 ms |               4.403059 ms | within |
| `search.startup`                    |              P95 <= 25 ms |               4.165956 ms | within |
| `tools.registry_dispatch`           |             P95 <= 100 us |              12.242800 us | within |
| `events.event_to_render`            |              P95 <= 20 ms |              16.183682 ms | within |
| `subagents.checkpoint_child_create` |             P95 <= 250 us |              95.433250 us | within |
| `snapcompact.throughput`            | median >= 500,000 chars/s |  4,110,956.433799 chars/s | within |

Latency budgets are documented rather than asserted in unit tests because scheduler and timer noise would make threshold tests brittle. Unit tests instead execute reduced samples and verify metric names, units, schema, finite statistics, and temporary-directory cleanup.

## Caveats

- OpenTUI is rendered headlessly. The first-draw value includes the dynamic UI import but excludes Bun process startup, CLI parsing, benchmark-suite module loading, terminal escape transport, compositor latency, and asynchronous runtime initialization that Brisk intentionally performs after mount.
- Except for OpenTUI first draw, results are warm-process measurements over OS-cached generated files. They do not represent cold boot or cold storage.
- The terminal metadata describes the launching environment, but the benchmark did not have a TTY and therefore did not measure Kitty itself.
- Atomic Hashline commit latency depends strongly on filesystem and storage flush behavior.
- Search startup depends on backend availability and executable version. The fallback path does materially different work.
- Snapcompact throughput depends on message entropy, selected model shape, frame count, native renderer version, and PNG compressibility. The one-frame synthetic fixture should not be extrapolated to arbitrary histories.
- In-memory checkpoint creation does not include checkpoint persistence, provider creation, model calls, or child execution.
- Seven samples characterize a quick local regression run, not a statistically rigorous hardware benchmark. Compare results only with the same schema, fixture details, runtime, and similarly controlled host conditions.
