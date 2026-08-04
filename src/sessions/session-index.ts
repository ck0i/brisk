import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  applyEntryToMetadata,
  isIsoTimestamp,
  isRecord,
  parseJsonLine,
  parseSessionEntry,
  parseSessionMetadata,
} from "./codec.ts";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  assertSafeSessionId,
  canonicalWorkspace,
  type SessionIndexRecord,
  type SessionMetadata,
} from "./types.ts";

export interface SessionIndexIO {
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly readText: (path: string) => Promise<string>;
  readonly listFiles: (path: string) => Promise<readonly string[]>;
  readonly writeTextExclusive: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly chmodFile: (path: string) => Promise<void>;
}

export interface SessionIndexOptions {
  readonly sessionsDir: string;
  readonly sessionIndexPath: string;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly io?: Partial<SessionIndexIO>;
}

export interface SessionListOptions {
  readonly workspace?: string;
}

export interface SessionIndexLoadInfo {
  readonly source: "cache" | "rebuild";
  readonly diagnostics: readonly string[];
}

interface SessionIndexCache {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly sessions: readonly SessionIndexRecord[];
}

const transcriptPattern = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;
const indexRelevantTypes = new Set([
  "session_metadata",
  "user_message",
  "model_change",
  "usage",
  "compaction",
  "child_session",
]);

const defaultIndexIO: SessionIndexIO = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  },
  async readText(path) {
    return await readFile(path, "utf8");
  },
  async listFiles(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  },
  async writeTextExclusive(path, data) {
    await writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await unlink(path);
  },
  async chmodFile(path) {
    await chmod(path, 0o600);
  },
};

/** Atomic, rebuildable cache of transcript metadata. */
export class SessionIndex {
  readonly sessionsDir: string;
  readonly sessionIndexPath: string;

  private readonly io: SessionIndexIO;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private records = new Map<string, SessionIndexRecord>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private loadInfoValue: SessionIndexLoadInfo | undefined;

  constructor(options: SessionIndexOptions) {
    this.sessionsDir = options.sessionsDir;
    this.sessionIndexPath = options.sessionIndexPath;
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.io = { ...defaultIndexIO, ...options.io };
  }

  get loadInfo(): SessionIndexLoadInfo | undefined {
    return this.loadInfoValue;
  }

  async load(): Promise<readonly SessionIndexRecord[]> {
    await this.ensureLoaded();
    return this.sortedRecords();
  }

  async list(options: SessionListOptions = {}): Promise<readonly SessionIndexRecord[]> {
    await this.ensureLoaded();
    const workspace =
      options.workspace === undefined ? undefined : canonicalWorkspace(options.workspace);
    return this.sortedRecords(workspace);
  }

  async get(id: string): Promise<SessionIndexRecord | undefined> {
    assertSafeSessionId(id);
    await this.ensureLoaded();
    const record = this.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async findLatestForWorkspace(workspace: string): Promise<SessionIndexRecord | undefined> {
    const records = await this.list({ workspace });
    return records[0];
  }

  async upsert(record: SessionIndexRecord): Promise<void> {
    const validated = parseSessionMetadata(record);
    if (!validated) throw new TypeError("Invalid session index record");
    await this.ensureLoaded();
    await this.enqueueMutation(async () => {
      const candidate = new Map(this.records);
      candidate.set(validated.id, validated);
      await this.persist(candidate);
      this.records = candidate;
    });
  }

  async remove(id: string): Promise<boolean> {
    assertSafeSessionId(id);
    await this.ensureLoaded();
    return await this.enqueueMutation(async () => {
      if (!this.records.has(id)) return false;
      const candidate = new Map(this.records);
      candidate.delete(id);
      await this.persist(candidate);
      this.records = candidate;
      return true;
    });
  }

  async rebuild(): Promise<readonly SessionIndexRecord[]> {
    await this.enqueueMutation(async () => {
      const diagnostics: string[] = [];
      await this.ensureDirectories();
      const rebuilt = await this.scanTranscripts(diagnostics);
      await this.persist(rebuilt);
      this.records = rebuilt;
      this.loaded = true;
      this.loadInfoValue = { source: "rebuild", diagnostics };
    });
    return this.sortedRecords();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromCacheOrRebuild().catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      });
    }
    await this.loadPromise;
  }

  private async loadFromCacheOrRebuild(): Promise<void> {
    await this.ensureDirectories();
    const diagnostics: string[] = [];
    try {
      const text = await this.io.readText(this.sessionIndexPath);
      const cache = parseCache(text);
      if (!cache) throw new Error("invalid session index cache");
      const records = new Map<string, SessionIndexRecord>();
      for (const record of cache.sessions) {
        if (records.has(record.id)) throw new Error(`duplicate session id ${record.id}`);
        records.set(record.id, record);
      }
      await this.io.chmodFile(this.sessionIndexPath);
      this.records = records;
      this.loaded = true;
      this.loadInfoValue = { source: "cache", diagnostics };
      return;
    } catch (error) {
      if (!isNotFound(error)) diagnostics.push(`Cache load failed: ${errorMessage(error)}`);
    }

    const rebuilt = await this.scanTranscripts(diagnostics);
    await this.persist(rebuilt);
    this.records = rebuilt;
    this.loaded = true;
    this.loadInfoValue = { source: "rebuild", diagnostics };
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      this.io.ensureDirectory(this.sessionsDir),
      this.io.ensureDirectory(dirname(this.sessionIndexPath)),
    ]);
  }

  private async scanTranscripts(diagnostics: string[]): Promise<Map<string, SessionIndexRecord>> {
    const records = new Map<string, SessionIndexRecord>();
    const filenames = await this.io.listFiles(this.sessionsDir);
    for (const filename of filenames) {
      const match = transcriptPattern.exec(filename);
      const id = match?.[1];
      if (!id) continue;
      try {
        const record = await this.scanTranscript(id, filename);
        if (record) records.set(record.id, record);
      } catch (error) {
        diagnostics.push(`Skipped ${filename}: ${errorMessage(error)}`);
      }
    }
    return records;
  }

  private async scanTranscript(
    id: string,
    filename: string,
  ): Promise<SessionIndexRecord | undefined> {
    const text = await this.io.readText(join(this.sessionsDir, filename));
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop();
    else lines.pop();

    let metadata: SessionMetadata | undefined;
    let lastSequence = 0;
    let latestTimestamp: string | undefined;

    for (const line of lines) {
      const json = parseJsonLine(line);
      if (!json.ok || !isRecord(json.value)) continue;
      const value = json.value;
      if (!isPositiveInteger(value.schemaVersion)) continue;
      if (!isPositiveInteger(value.sequence) || value.sequence <= lastSequence) continue;
      if (!isIsoTimestamp(value.timestamp) || typeof value.type !== "string") continue;
      lastSequence = value.sequence;
      if (latestTimestamp === undefined || value.timestamp > latestTimestamp) {
        latestTimestamp = value.timestamp;
      }
      if (value.schemaVersion !== SESSION_SCHEMA_VERSION || !indexRelevantTypes.has(value.type)) {
        continue;
      }
      const parsed = parseSessionEntry(value);
      if (!parsed.ok || parsed.entry.type === "unknown") continue;
      if (parsed.entry.type === "session_metadata" && parsed.entry.metadata.id !== id) continue;
      metadata = applyEntryToMetadata(metadata, parsed.entry);
    }

    if (!metadata) return undefined;
    if (latestTimestamp !== undefined && latestTimestamp > metadata.updatedAt) {
      metadata = { ...metadata, updatedAt: latestTimestamp };
    }
    return metadata;
  }

  private async persist(records: ReadonlyMap<string, SessionIndexRecord>): Promise<void> {
    await this.ensureDirectories();
    const cache: SessionIndexCache = {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      sessions: sortRecords([...records.values()]),
    };
    const temporaryId = this.generateId();
    assertSafeSessionId(temporaryId);
    const temporaryPath = `${this.sessionIndexPath}.tmp-${temporaryId}`;
    try {
      await this.io.writeTextExclusive(temporaryPath, `${JSON.stringify(cache)}\n`);
      await this.io.rename(temporaryPath, this.sessionIndexPath);
      await this.io.chmodFile(this.sessionIndexPath);
    } catch (error) {
      try {
        await this.io.remove(temporaryPath);
      } catch {
        // the temporary file may not have been created
      }
      throw error;
    }
  }

  private sortedRecords(workspace?: string): readonly SessionIndexRecord[] {
    const records = [...this.records.values()].filter(
      (record) => workspace === undefined || record.workspace === workspace,
    );
    return sortRecords(records).map(cloneRecord);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseCache(text: string): SessionIndexCache | undefined {
  const json = parseJsonLine(text.trim());
  if (!json.ok || !isRecord(json.value)) return undefined;
  const value = json.value;
  if (value.schemaVersion !== SESSION_INDEX_SCHEMA_VERSION) return undefined;
  if (!isIsoTimestamp(value.updatedAt) || !Array.isArray(value.sessions)) return undefined;
  const sessions: SessionIndexRecord[] = [];
  for (const recordValue of value.sessions) {
    const record = parseSessionMetadata(recordValue);
    if (!record) return undefined;
    sessions.push(record);
  }
  return {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    updatedAt: value.updatedAt,
    sessions,
  };
}

function sortRecords(records: readonly SessionIndexRecord[]): SessionIndexRecord[] {
  return [...records].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function cloneRecord(record: SessionIndexRecord): SessionIndexRecord {
  return {
    ...record,
    usageTotals: { ...record.usageTotals },
    childRefs: record.childRefs.map((child) => ({ ...child })),
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
