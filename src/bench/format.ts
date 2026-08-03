import type { BenchmarkMetric, BenchmarkReport } from "./types.ts";

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const memoryGiB = report.system.totalMemoryBytes / 1024 ** 3;
  const lines = [
    `Brisk local benchmark (schema ${report.schemaVersion})`,
    `Generated: ${report.generatedAt}`,
    `System: ${report.system.cpuModel}; ${report.system.logicalCpuCount} logical CPUs; ${memoryGiB.toFixed(1)} GiB RAM`,
    `Runtime: ${report.system.platform} ${report.system.release} ${report.system.architecture}; Bun ${report.system.bunVersion}`,
    `Method: process.hrtime.bigint; generated temporary data; network disabled; ${report.methodology.durationMs.toFixed(1)} ms total`,
    "",
    `${"Metric".padEnd(42)} ${"median".padStart(14)} ${"p95".padStart(14)} ${"samples".padStart(9)} ${"warmups".padStart(9)}`,
    `${"-".repeat(42)} ${"-".repeat(14)} ${"-".repeat(14)} ${"-".repeat(9)} ${"-".repeat(9)}`,
  ];
  for (const metric of report.metrics) lines.push(formatMetric(metric));
  return `${lines.join("\n")}\n`;
}

function formatMetric(metric: BenchmarkMetric): string {
  const median = `${formatValue(metric.statistics.median, metric.unit)} ${metric.unit}`;
  const p95 = `${formatValue(metric.statistics.p95, metric.unit)} ${metric.unit}`;
  return `${metric.name.padEnd(42)} ${median.padStart(14)} ${p95.padStart(14)} ${String(metric.sampleCount).padStart(9)} ${String(metric.warmupCount).padStart(9)}`;
}

function formatValue(value: number, unit: BenchmarkMetric["unit"]): string {
  if (unit === "chars/s") return value.toFixed(0);
  return value.toFixed(3);
}
