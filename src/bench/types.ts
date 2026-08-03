export const BENCHMARK_SCHEMA_VERSION = 1 as const;

export const BENCHMARK_METRIC_NAMES = [
  "config.load",
  "opentui.first_draw",
  "sessions.index_load",
  "sessions.open",
  "hashline.read_format",
  "hashline.patch_apply",
  "search.startup",
  "tools.registry_dispatch",
  "events.event_to_render",
  "subagents.checkpoint_child_create",
  "snapcompact.throughput",
] as const;

export type BenchmarkMetricName = (typeof BENCHMARK_METRIC_NAMES)[number];
export type BenchmarkUnit = "ms" | "us" | "chars/s";
export type BenchmarkDetail = string | number | boolean;

export interface BenchmarkStatistics {
  readonly min: number;
  readonly median: number;
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

export interface BenchmarkMetric {
  readonly name: BenchmarkMetricName;
  readonly description: string;
  readonly unit: BenchmarkUnit;
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly operationsPerSample: number;
  readonly statistics: BenchmarkStatistics;
  readonly details: Readonly<Record<string, BenchmarkDetail>>;
}

export interface BenchmarkSystem {
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryBytes: number;
  readonly bunVersion: string;
}

export interface BenchmarkMethodology {
  readonly clock: "process.hrtime.bigint";
  readonly sampleCount: number;
  readonly defaultWarmupCount: number;
  readonly temporaryData: "generated";
  readonly networkAccess: false;
  readonly durationMs: number;
}

export interface BenchmarkReport {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly suite: "brisk-local";
  readonly generatedAt: string;
  readonly system: BenchmarkSystem;
  readonly methodology: BenchmarkMethodology;
  readonly metrics: readonly BenchmarkMetric[];
}

export interface BenchmarkOptions {
  /** Recorded samples for every metric except the inherently one-shot first draw. */
  readonly sampleCount?: number;
  /** Discarded samples for repeatable metrics. */
  readonly warmupCount?: number;
  /** Internal no-op dispatches normalized into each ToolRegistry sample. */
  readonly toolDispatchesPerSample?: number;
  /** In-memory checkpoint/session pairs normalized into each subagent sample. */
  readonly childCreationsPerSample?: number;
  /** EventBatcher's frame interval. Tests may lower this without asserting latency. */
  readonly eventFrameMs?: number;
  /** Parent for the private, automatically removed benchmark directory. */
  readonly temporaryParent?: string;
}
