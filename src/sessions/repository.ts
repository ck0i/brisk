import { applyEntryToMetadata } from "./codec.ts";
import { SessionIndex, type SessionIndexIO, type SessionListOptions } from "./session-index.ts";
import { SessionStore, type SessionStoreIO } from "./store.ts";
import type {
  CreateSessionOptions,
  LoadedSession,
  RepositoryAppendResult,
  RepositoryCreateResult,
  SessionEntry,
  SessionEntryInput,
  SessionFsyncPolicy,
  SessionIndexRecord,
  SessionMetadata,
} from "./types.ts";

export interface SessionRepositoryOptions {
  readonly sessionsDir: string;
  readonly sessionIndexPath: string;
  readonly fsyncPolicy?: SessionFsyncPolicy;
  readonly storeIO?: Partial<SessionStoreIO>;
  readonly indexIO?: Partial<SessionIndexIO>;
  readonly store?: SessionStore;
  readonly index?: SessionIndex;
}

/** Coordinates durable transcripts with their disposable index cache. */
export class SessionRepository {
  readonly store: SessionStore;
  readonly index: SessionIndex;

  private readonly metadata = new Map<string, SessionMetadata>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private lastIndexErrorValue: Error | undefined;

  constructor(options: SessionRepositoryOptions) {
    this.store =
      options.store ??
      new SessionStore({
        sessionsDir: options.sessionsDir,
        ...(options.fsyncPolicy === undefined ? {} : { fsyncPolicy: options.fsyncPolicy }),
        ...(options.storeIO === undefined ? {} : { io: options.storeIO }),
      });
    this.index =
      options.index ??
      new SessionIndex({
        sessionsDir: options.sessionsDir,
        sessionIndexPath: options.sessionIndexPath,
        ...(options.indexIO === undefined ? {} : { io: options.indexIO }),
      });
  }

  get lastIndexError(): Error | undefined {
    return this.lastIndexErrorValue;
  }

  async create(options: CreateSessionOptions): Promise<RepositoryCreateResult> {
    const metadata = await this.store.create(options);
    this.metadata.set(metadata.id, metadata);
    const indexError = await this.updateIndex(metadata);
    return {
      metadata,
      ...(indexError === undefined ? {} : { indexError }),
    };
  }

  async append(id: string, input: SessionEntryInput): Promise<RepositoryAppendResult> {
    return await this.appendBatch(id, [input]);
  }

  async appendBatch(
    id: string,
    inputs: readonly SessionEntryInput[],
  ): Promise<RepositoryAppendResult> {
    return await this.enqueueSession(id, async () => {
      let current = this.metadata.get(id);
      if (!current) {
        const loaded = await this.store.open(id);
        current = loaded.metadata;
        this.metadata.set(id, current);
      }

      const entries = await this.store.appendBatch(id, inputs);
      for (const entry of entries) current = applyKnownEntry(current, entry);
      this.metadata.set(id, current);
      const indexError = await this.updateIndex(current);
      return {
        entries,
        ...(indexError === undefined ? {} : { indexError }),
      };
    });
  }

  async open(id: string): Promise<LoadedSession> {
    const loaded = await this.store.open(id);
    this.metadata.set(id, loaded.metadata);
    return loaded;
  }

  async continueLatest(workspace: string): Promise<LoadedSession | undefined> {
    const latest = await this.index.findLatestForWorkspace(workspace);
    if (!latest) return undefined;
    return await this.open(latest.id);
  }

  async list(options: SessionListOptions = {}): Promise<readonly SessionIndexRecord[]> {
    return await this.index.list(options);
  }

  async rebuildIndex(): Promise<readonly SessionIndexRecord[]> {
    const records = await this.index.rebuild();
    this.lastIndexErrorValue = undefined;
    return records;
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private async updateIndex(metadata: SessionMetadata): Promise<Error | undefined> {
    try {
      await this.index.upsert(metadata);
      this.lastIndexErrorValue = undefined;
      return undefined;
    } catch (error) {
      const indexError = asError(error);
      this.lastIndexErrorValue = indexError;
      return indexError;
    }
  }

  private enqueueSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.sessionQueues.set(id, settled);
    settled.finally(() => {
      if (this.sessionQueues.get(id) === settled) this.sessionQueues.delete(id);
    });
    return result;
  }
}

function applyKnownEntry(metadata: SessionMetadata, entry: SessionEntry): SessionMetadata {
  const updated = applyEntryToMetadata(metadata, entry);
  if (!updated) throw new Error("Session metadata unexpectedly missing after append");
  return updated;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
