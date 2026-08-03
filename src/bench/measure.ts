import type { BenchmarkStatistics, BenchmarkUnit } from "./types.ts";

export interface OperationMeasurementOptions {
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly operationsPerSample?: number;
  readonly unit: Extract<BenchmarkUnit, "ms" | "us">;
  readonly operation: () => void | Promise<void>;
}

export async function measureOperation(
  options: OperationMeasurementOptions,
): Promise<BenchmarkStatistics> {
  const operations = options.operationsPerSample ?? 1;
  assertPositiveInteger(operations, "operationsPerSample");
  return await measureValues(options.sampleCount, options.warmupCount, async () => {
    const startedAt = process.hrtime.bigint();
    for (let index = 0; index < operations; index += 1) await options.operation();
    const nanoseconds = Number(process.hrtime.bigint() - startedAt) / operations;
    return options.unit === "ms" ? nanoseconds / 1_000_000 : nanoseconds / 1_000;
  });
}

export async function measurePreparedOperation(options: {
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly unit: Extract<BenchmarkUnit, "ms" | "us">;
  readonly prepare: () => Promise<() => void | Promise<void>>;
}): Promise<BenchmarkStatistics> {
  return await measureValues(options.sampleCount, options.warmupCount, async () => {
    const operation = await options.prepare();
    const startedAt = process.hrtime.bigint();
    await operation();
    const nanoseconds = Number(process.hrtime.bigint() - startedAt);
    return options.unit === "ms" ? nanoseconds / 1_000_000 : nanoseconds / 1_000;
  });
}

export async function measureValues(
  sampleCount: number,
  warmupCount: number,
  sample: () => number | Promise<number>,
): Promise<BenchmarkStatistics> {
  assertPositiveInteger(sampleCount, "sampleCount");
  assertNonNegativeInteger(warmupCount, "warmupCount");
  for (let index = 0; index < warmupCount; index += 1) await sample();

  const values: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const value = await sample();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Benchmark sample must be a non-negative finite number; got ${value}`);
    }
    values.push(value);
  }
  return summarize(values);
}

export function summarize(values: readonly number[]): BenchmarkStatistics {
  if (values.length === 0) throw new Error("Cannot summarize an empty benchmark sample");
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const midpoint = Math.floor(sorted.length / 2);
  const middle = sorted[midpoint];
  if (middle === undefined) throw new Error("Benchmark median invariant failed");
  const median = sorted.length % 2 === 0 ? ((sorted[midpoint - 1] ?? middle) + middle) / 2 : middle;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[p95Index];
  const min = sorted[0];
  const max = sorted.at(-1);
  if (p95 === undefined || min === undefined || max === undefined) {
    throw new Error("Benchmark statistics invariant failed");
  }
  return {
    min: rounded(min),
    median: rounded(median),
    mean: rounded(sum / sorted.length),
    p95: rounded(p95),
    max: rounded(max),
  };
}

export function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
