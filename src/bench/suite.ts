import type { Message as PiMessage } from "@oh-my-pi/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../config/load.ts";
import { projectConfigPath, resolveConfigPaths, type ConfigPaths } from "../config/paths.ts";
import { EventBatcher } from "../core/event-batcher.ts";
import type { Message, ToolCall } from "../core/messages.ts";
import { SessionIndex } from "../sessions/session-index.ts";
import { SessionRepository } from "../sessions/repository.ts";
import { SessionStore } from "../sessions/store.ts";
import type { SessionEntryInput } from "../sessions/types.ts";
import { CheckpointStore } from "../subagents/checkpoint.ts";
import { ChildSession } from "../subagents/child-session.ts";
import { HashlineWorkspace } from "../tools/hashline-workspace.ts";
import { searchWorkspace, type SearchResult } from "../tools/search.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  elapsedMilliseconds,
  measureOperation,
  measurePreparedOperation,
  measureValues,
} from "./measure.ts";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkDetail,
  type BenchmarkMetric,
  type BenchmarkMetricName,
  type BenchmarkOptions,
  type BenchmarkReport,
  type BenchmarkStatistics,
  type BenchmarkSystem,
  type BenchmarkUnit,
} from "./types.ts";

const DEFAULT_SAMPLE_COUNT = 7;
const DEFAULT_WARMUP_COUNT = 2;
const DEFAULT_TOOL_DISPATCHES = 50;
const DEFAULT_CHILD_CREATIONS = 20;
const DEFAULT_EVENT_FRAME_MS = 16;
const SESSION_COUNT = 24;
const SESSION_TURN_COUNT = 80;
const HASHLINE_LINE_COUNT = 512;

interface ResolvedOptions {
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly toolDispatchesPerSample: number;
  readonly childCreationsPerSample: number;
  readonly eventFrameMs: number;
  readonly temporaryParent: string;
}

interface SessionFixture {
  readonly sessionsDir: string;
  readonly indexPath: string;
  readonly targetId: string;
}

interface HashlineFixture {
  readonly readWorkspace: HashlineWorkspace;
  readonly patchWorkspace: HashlineWorkspace;
  readonly patchPath: string;
  preparePatch(): Promise<() => Promise<void>>;
}

export async function runBenchmarks(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const resolved = resolveOptions(options);
  const suiteStartedAt = process.hrtime.bigint();
  const root = await mkdtemp(join(resolved.temporaryParent, "brisk-bench-"));

  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const [configPaths, sessionFixture, hashlineFixture, searchRoot] = await Promise.all([
      setupConfigFixture(root, workspace),
      setupSessionFixture(root, workspace),
      setupHashlineFixture(root),
      setupSearchFixture(root),
    ]);

    const metrics: BenchmarkMetric[] = [];
    metrics.push(await benchmarkConfig(configPaths, workspace, resolved));
    metrics.push(await benchmarkFirstDraw());
    metrics.push(await benchmarkSessionIndex(sessionFixture, resolved));
    metrics.push(await benchmarkSessionOpen(sessionFixture, resolved));
    metrics.push(await benchmarkHashlineRead(hashlineFixture, resolved));
    metrics.push(await benchmarkHashlinePatch(hashlineFixture, resolved));
    metrics.push(await benchmarkSearch(searchRoot, resolved));
    metrics.push(await benchmarkToolRegistry(resolved));
    metrics.push(await benchmarkEventBatcher(resolved));
    metrics.push(await benchmarkChildCreation(resolved));
    metrics.push(await benchmarkSnapcompact(resolved));

    return {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      suite: "brisk-local",
      generatedAt: new Date().toISOString(),
      system: discoverSystem(),
      methodology: {
        clock: "process.hrtime.bigint",
        sampleCount: resolved.sampleCount,
        defaultWarmupCount: resolved.warmupCount,
        temporaryData: "generated",
        networkAccess: false,
        durationMs: Number(elapsedMilliseconds(suiteStartedAt).toFixed(3)),
      },
      metrics,
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function benchmarkConfig(
  paths: ConfigPaths,
  workspace: string,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    operation: async () => {
      const loaded = await loadConfig({ paths, workspace });
      if (loaded.config.permissionMode !== "safe")
        throw new Error("Configuration fixture mismatch");
    },
  });
  return metric(
    "config.load",
    "Load and validate merged global and project JSONC configuration",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { layers: 2 },
  );
}

async function benchmarkFirstDraw(): Promise<BenchmarkMetric> {
  const startedAt = process.hrtime.bigint();
  const { benchmarkFirstDraw } = await import("../ui/benchmark.tsx");
  await benchmarkFirstDraw();
  const statistics = singleStatistic(elapsedMilliseconds(startedAt));
  return metric(
    "opentui.first_draw",
    "Dynamically import OpenTUI/Solid, mount Brisk's root, and complete one headless draw",
    "ms",
    1,
    0,
    1,
    statistics,
    { width: 100, height: 30, headless: true, includesDynamicImport: true },
  );
}

async function benchmarkSessionIndex(
  fixture: SessionFixture,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    operation: async () => {
      const index = new SessionIndex({
        sessionsDir: fixture.sessionsDir,
        sessionIndexPath: fixture.indexPath,
      });
      const records = await index.load();
      if (records.length !== SESSION_COUNT || index.loadInfo?.source !== "cache") {
        throw new Error("Session index fixture mismatch");
      }
    },
  });
  return metric(
    "sessions.index_load",
    "Open, parse, validate, and sort a populated disposable session-index cache",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { indexedSessions: SESSION_COUNT, source: "cache" },
  );
}

async function benchmarkSessionOpen(
  fixture: SessionFixture,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    operation: async () => {
      const store = new SessionStore({ sessionsDir: fixture.sessionsDir, fsyncPolicy: "never" });
      const loaded = await store.open(fixture.targetId);
      if (loaded.messages.length !== SESSION_TURN_COUNT * 2) {
        throw new Error("Session transcript fixture mismatch");
      }
    },
  });
  return metric(
    "sessions.open",
    "Read, validate, and reconstruct a generated append-only session transcript",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { transcriptMessages: SESSION_TURN_COUNT * 2 },
  );
}

async function benchmarkHashlineRead(
  fixture: HashlineFixture,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    operation: async () => {
      const result = await fixture.readWorkspace.read({ path: "read.txt" });
      if (result.seenLines.length !== HASHLINE_LINE_COUNT + 1) {
        throw new Error("Hashline read fixture mismatch");
      }
    },
  });
  return metric(
    "hashline.read_format",
    "Read UTF-8, hash it, number every line, and record a Hashline snapshot",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { sourceLines: HASHLINE_LINE_COUNT, sourceBytes: generatedHashlineText().length },
  );
}

async function benchmarkHashlinePatch(
  fixture: HashlineFixture,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  const statistics = await measurePreparedOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    prepare: async () => await fixture.preparePatch(),
  });
  return metric(
    "hashline.patch_apply",
    "Parse, stage, diff, revalidate, and atomically commit one native Hashline PUT",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { sourceLines: HASHLINE_LINE_COUNT, changedLines: 1, atomicCommit: true },
  );
}

async function benchmarkSearch(
  searchRoot: string,
  options: ResolvedOptions,
): Promise<BenchmarkMetric> {
  let lastResult: SearchResult | undefined;
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    unit: "ms",
    operation: async () => {
      lastResult = await searchWorkspace(searchRoot, {
        pattern: "brisk-benchmark-no-match",
        limit: 1,
      });
      if (lastResult.matches.length !== 0) throw new Error("Search fixture unexpectedly matched");
    },
  });
  return metric(
    "search.startup",
    "Start the selected local search backend and complete a no-match search in a tiny workspace",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { backend: lastResult?.backend ?? "unknown", files: 1 },
  );
}

async function benchmarkToolRegistry(options: ResolvedOptions): Promise<BenchmarkMetric> {
  const registry = new ToolRegistry();
  registry.register({
    name: "benchmark_noop",
    description: "Local benchmark no-op",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
    parallelSafe: true,
    execute: () => ({ content: "ok" }),
  });
  const call: ToolCall = { id: "benchmark-call", name: "benchmark_noop", arguments: "{}" };
  const signal = new AbortController().signal;
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    operationsPerSample: options.toolDispatchesPerSample,
    unit: "us",
    operation: async () => {
      const result = await registry.execute([call], signal);
      if (result[0]?.content !== "ok") throw new Error("ToolRegistry fixture mismatch");
    },
  });
  return metric(
    "tools.registry_dispatch",
    "Validate JSON arguments and dispatch one local no-op through ToolRegistry",
    "us",
    options.sampleCount,
    options.warmupCount,
    options.toolDispatchesPerSample,
    statistics,
    { schemaValidation: true, deadlineLifecycle: true },
  );
}

async function benchmarkEventBatcher(options: ResolvedOptions): Promise<BenchmarkMetric> {
  const statistics = await measureValues(
    options.sampleCount,
    options.warmupCount,
    async () => await eventToRenderLatency(options.eventFrameMs),
  );
  return metric(
    "events.event_to_render",
    "Queue an event immediately after a flush and observe it at the next EventBatcher frame",
    "ms",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { configuredFrameMs: options.eventFrameMs },
  );
}

async function benchmarkChildCreation(options: ResolvedOptions): Promise<BenchmarkMetric> {
  const prefix = generatedCheckpointMessages();
  let sequence = 0;
  const statistics = await measureOperation({
    sampleCount: options.sampleCount,
    warmupCount: options.warmupCount,
    operationsPerSample: options.childCreationsPerSample,
    unit: "us",
    operation: async () => {
      const store = new CheckpointStore();
      const checkpoint = await store.capture(prefix);
      const id = `benchmark-child-${sequence++}`;
      const child = new ChildSession({
        childSessionId: id,
        checkpoint,
        input: { description: "Inspect the synthetic benchmark context", mode: "research" },
        model: "benchmark/local",
        depth: 1,
      });
      if (child.inspect().checkpointId !== checkpoint.id) {
        throw new Error("Child checkpoint fixture mismatch");
      }
    },
  });
  return metric(
    "subagents.checkpoint_child_create",
    "Hash and freeze an in-memory checkpoint, then create one isolated child session",
    "us",
    options.sampleCount,
    options.warmupCount,
    options.childCreationsPerSample,
    statistics,
    { prefixMessages: prefix.length, persistence: false },
  );
}

async function benchmarkSnapcompact(options: ResolvedOptions): Promise<BenchmarkMetric> {
  const snapcompact = await import("@oh-my-pi/snapcompact");
  const baselineMessages = generatedSnapcompactMessages(0);
  const sourceCharacters = baselineMessages.reduce(
    (total, message) => total + (typeof message.content === "string" ? message.content.length : 0),
    0,
  );
  let renderedFrames = 0;
  let pass = 0;
  const statistics = await measureValues(options.sampleCount, options.warmupCount, async () => {
    const messages = generatedSnapcompactMessages(pass++);
    const startedAt = process.hrtime.bigint();
    const result = await snapcompact.compact(
      {
        firstKeptEntryId: "benchmark-first-kept",
        messagesToSummarize: messages,
        turnPrefixMessages: [],
        tokensBefore: Math.ceil(sourceCharacters / 4),
        fileOps: snapcompact.createFileOps(),
      },
      {
        model: { api: "anthropic-messages", id: "claude-sonnet-benchmark" },
        maxFrames: 1,
        includeThinking: false,
      },
    );
    const archive = snapcompact.getPreservedArchive(result.preserveData);
    renderedFrames = archive?.frames.length ?? 0;
    if (!archive || archive.totalChars <= 0) {
      throw new Error("Snapcompact fixture produced no archive");
    }
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    return sourceCharacters / elapsedSeconds;
  });
  return metric(
    "snapcompact.throughput",
    "Serialize, normalize, plan, rasterize, and PNG-encode generated history locally",
    "chars/s",
    options.sampleCount,
    options.warmupCount,
    1,
    statistics,
    { sourceCharacters, maxFrames: 1, renderedFrames },
  );
}

async function setupConfigFixture(root: string, workspace: string): Promise<ConfigPaths> {
  const home = join(root, "home");
  const paths = resolveConfigPaths({
    homeDir: home,
    env: {
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "localappdata"),
    },
  });
  const projectPath = projectConfigPath(workspace, paths.platform);
  await Promise.all([
    mkdir(dirname(paths.globalConfigPath), { recursive: true }),
    mkdir(dirname(projectPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      paths.globalConfigPath,
      '{\n  // generated benchmark layer\n  "permissionMode": "safe",\n  "ui": { "theme": "default" }\n}\n',
    ),
    writeFile(
      projectPath,
      '{\n  "maxSubagents": 2,\n  "compaction": { "thresholdPercent": 80 }\n}\n',
    ),
  ]);
  return paths;
}

async function setupSessionFixture(root: string, workspace: string): Promise<SessionFixture> {
  const sessionsDir = join(root, "sessions");
  const indexPath = join(root, "session-index.json");
  const repository = new SessionRepository({
    sessionsDir,
    sessionIndexPath: indexPath,
    fsyncPolicy: "never",
  });
  const targetId = "bench-session-00";
  try {
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const id = `bench-session-${String(index).padStart(2, "0")}`;
      await repository.create({
        id,
        title: `Generated benchmark session ${index}`,
        workspace,
        selectedProvider: "benchmark",
        selectedModel: "local",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }
    await repository.appendBatch(targetId, generatedSessionEntries());
  } finally {
    await repository.close();
  }
  return { sessionsDir, indexPath, targetId };
}

async function setupHashlineFixture(root: string): Promise<HashlineFixture> {
  const workspace = join(root, "hashline");
  await mkdir(workspace, { recursive: true });
  const source = generatedHashlineText();
  await Promise.all([
    writeFile(join(workspace, "read.txt"), source),
    writeFile(join(workspace, "patch.txt"), source),
  ]);
  const readWorkspace = new HashlineWorkspace({ workspace });
  const patchWorkspace = new HashlineWorkspace({ workspace });
  const patchPath = "patch.txt";
  let useAlternate = true;
  return {
    readWorkspace,
    patchWorkspace,
    patchPath,
    async preparePatch() {
      const read = await patchWorkspace.read({ path: patchPath });
      const replacement = useAlternate ? "line-0256-patched-a" : "line-0256-patched-b";
      useAlternate = !useAlternate;
      return async () => {
        const pending = await patchWorkspace.edit({
          patch: `${read.header}\nPUT 256.=256:\n+${replacement}`,
        });
        await pending.commit();
      };
    },
  };
}

async function setupSearchFixture(root: string): Promise<string> {
  const workspace = join(root, "search");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "fixture.txt"),
    "Synthetic local search fixture.\nThere is deliberately no matching sentinel here.\n",
  );
  return workspace;
}

function generatedSessionEntries(): SessionEntryInput[] {
  const entries: SessionEntryInput[] = [];
  for (let index = 0; index < SESSION_TURN_COUNT; index += 1) {
    entries.push({
      type: "user_message",
      message: {
        role: "user",
        content: `Generated request ${index}: inspect fixture-${index}.txt`,
      },
    });
    entries.push({
      type: "assistant_message",
      message: {
        role: "assistant",
        content: `Generated response ${index}: no repository data was read.`,
        toolCalls: [],
        usage: { inputTokens: 20 + index, outputTokens: 10 },
        provider: "benchmark",
        model: "local",
      },
    });
  }
  return entries;
}

function generatedHashlineText(): string {
  return (
    Array.from(
      { length: HASHLINE_LINE_COUNT },
      (_, index) =>
        `line-${String(index + 1).padStart(4, "0")}: synthetic benchmark payload alpha beta gamma`,
    ).join("\n") + "\n"
  );
}

function generatedCheckpointMessages(): readonly Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push({
      role: "user",
      content: `Synthetic checkpoint request ${index}: inspect generated unit ${index}.`,
    });
    messages.push({
      role: "assistant",
      content: `Synthetic checkpoint response ${index}.`,
      toolCalls: [],
    });
  }
  return messages;
}

function generatedSnapcompactMessages(variant: number): PiMessage[] {
  const phrase =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu synthetic local benchmark ";
  const variantLabel = String(variant % 1_000_000).padStart(6, "0");
  const messages: PiMessage[] = [];
  for (let index = 0; index < 48; index += 1) {
    messages.push({
      role: "user",
      content: `Generated turn ${String(index).padStart(2, "0")} variant ${variantLabel}. ${phrase.repeat(16)}`,
      timestamp: Date.UTC(2026, 0, 1, 0, 0, index),
    });
  }
  return messages;
}

function eventToRenderLatency(frameMs: number): Promise<number> {
  return new Promise((resolve) => {
    let startedAt = 0n;
    let batcher: EventBatcher<string>;
    batcher = new EventBatcher<string>((events) => {
      if (!events.includes("render")) return;
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      batcher.cancel();
      resolve(elapsed);
    }, frameMs);
    batcher.push("prime");
    startedAt = process.hrtime.bigint();
    batcher.push("render");
  });
}

function resolveOptions(options: BenchmarkOptions): ResolvedOptions {
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const warmupCount = options.warmupCount ?? DEFAULT_WARMUP_COUNT;
  const toolDispatchesPerSample = options.toolDispatchesPerSample ?? DEFAULT_TOOL_DISPATCHES;
  const childCreationsPerSample = options.childCreationsPerSample ?? DEFAULT_CHILD_CREATIONS;
  const eventFrameMs = options.eventFrameMs ?? DEFAULT_EVENT_FRAME_MS;
  assertPositiveInteger(sampleCount, "sampleCount");
  assertNonNegativeInteger(warmupCount, "warmupCount");
  assertPositiveInteger(toolDispatchesPerSample, "toolDispatchesPerSample");
  assertPositiveInteger(childCreationsPerSample, "childCreationsPerSample");
  if (!Number.isFinite(eventFrameMs) || eventFrameMs <= 0) {
    throw new RangeError("eventFrameMs must be a positive finite number");
  }
  return {
    sampleCount,
    warmupCount,
    toolDispatchesPerSample,
    childCreationsPerSample,
    eventFrameMs,
    temporaryParent: options.temporaryParent ?? tmpdir(),
  };
}

function discoverSystem(): BenchmarkSystem {
  const processors = cpus();
  return {
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpuModel: processors[0]?.model.trim() || "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    bunVersion: process.versions.bun ?? "unknown",
  };
}

function metric(
  name: BenchmarkMetricName,
  description: string,
  unit: BenchmarkUnit,
  sampleCount: number,
  warmupCount: number,
  operationsPerSample: number,
  statistics: BenchmarkStatistics,
  details: Readonly<Record<string, BenchmarkDetail>>,
): BenchmarkMetric {
  return {
    name,
    description,
    unit,
    sampleCount,
    warmupCount,
    operationsPerSample,
    statistics,
    details,
  };
}

function singleStatistic(value: number): BenchmarkStatistics {
  const rounded = Number(value.toFixed(6));
  return { min: rounded, median: rounded, mean: rounded, p95: rounded, max: rounded };
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
