import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BENCHMARK_METRIC_NAMES,
  BENCHMARK_SCHEMA_VERSION,
  formatBenchmarkReport,
  runBenchmarks,
  type BenchmarkMetricName,
  type BenchmarkUnit,
} from "../../src/bench/index.ts";
import { summarize } from "../../src/bench/measure.ts";

const temporaryPaths: string[] = [];

const expectedUnits = {
  "config.load": "ms",
  "opentui.first_draw": "ms",
  "sessions.index_load": "ms",
  "sessions.open": "ms",
  "hashline.read_format": "ms",
  "hashline.patch_apply": "ms",
  "search.startup": "ms",
  "tools.registry_dispatch": "us",
  "events.event_to_render": "ms",
  "subagents.checkpoint_child_create": "us",
  "snapcompact.throughput": "chars/s",
} satisfies Readonly<Record<BenchmarkMetricName, BenchmarkUnit>>;

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local benchmark", () => {
  test("executes every metric with a stable machine-readable schema and removes fixtures", async () => {
    const parent = await mkdtemp(join(tmpdir(), "brisk-benchmark-test-"));
    temporaryPaths.push(parent);
    const report = await runBenchmarks({
      sampleCount: 1,
      warmupCount: 0,
      toolDispatchesPerSample: 1,
      childCreationsPerSample: 1,
      eventFrameMs: 1,
      temporaryParent: parent,
    });

    expect(report.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(report.suite).toBe("brisk-local");
    expect(report.methodology).toMatchObject({
      clock: "process.hrtime.bigint",
      sampleCount: 1,
      defaultWarmupCount: 0,
      temporaryData: "generated",
      networkAccess: false,
    });
    expect(report.metrics.map((metric) => metric.name)).toEqual([...BENCHMARK_METRIC_NAMES]);
    expect(Object.keys(report).sort()).toEqual([
      "generatedAt",
      "methodology",
      "metrics",
      "schemaVersion",
      "suite",
      "system",
    ]);

    for (const metric of report.metrics) {
      expect(Object.keys(metric).sort()).toEqual([
        "description",
        "details",
        "name",
        "operationsPerSample",
        "sampleCount",
        "statistics",
        "unit",
        "warmupCount",
      ]);
      expect(metric.unit).toBe(expectedUnits[metric.name]);
      expect(metric.sampleCount).toBe(1);
      expect(metric.warmupCount).toBe(0);
      expect(metric.operationsPerSample).toBeGreaterThan(0);
      expect(metric.description.length).toBeGreaterThan(0);
      expect(Object.keys(metric.statistics).sort()).toEqual([
        "max",
        "mean",
        "median",
        "min",
        "p95",
      ]);
      for (const value of Object.values(metric.statistics)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }

    const serialized = JSON.stringify(report);
    expect(JSON.parse(serialized)).toEqual(report);
    expect(serialized).not.toContain(parent);
    expect(formatBenchmarkReport(report)).toContain("snapcompact.throughput");
    expect(await readdir(parent)).toEqual([]);
  }, 15_000);

  test("uses deterministic median, mean, and nearest-rank p95 calculations", () => {
    expect(summarize([5, 1, 4, 2])).toEqual({
      min: 1,
      median: 3,
      mean: 3,
      p95: 5,
      max: 5,
    });
  });
});
