import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../core/messages.ts";

export interface Checkpoint {
  readonly id: string;
  readonly messages: readonly Message[];
}

export interface CheckpointStoreOptions {
  readonly directory?: string;
  readonly maxEntries?: number;
}

interface StoredCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly persistence: Promise<void>;
  references: number;
  lastUsed: number;
}

interface CheckpointDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly messages: readonly Message[];
}

/** Content-addressed immutable storage for provider-ready context prefixes. */
export class CheckpointStore {
  private readonly directory: string | undefined;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, StoredCheckpoint>();
  private clock = 0;

  constructor(options: CheckpointStoreOptions = {}) {
    this.directory = options.directory;
    this.maxEntries = options.maxEntries ?? 32;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError("Checkpoint maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Captures and retains one prefix. Equal content returns the same object identity. */
  async capture(messages: readonly Message[]): Promise<Checkpoint> {
    const serialized = stableStringify(messages);
    const id = createHash("sha256").update(serialized).digest("hex");
    const existing = this.entries.get(id);
    if (existing) {
      existing.references += 1;
      existing.lastUsed = ++this.clock;
      await existing.persistence;
      return existing.checkpoint;
    }

    const immutableMessages = deepFreeze(structuredClone(messages)) as readonly Message[];
    const checkpoint = Object.freeze({ id, messages: immutableMessages });
    const persistence = this.directory
      ? persistCheckpoint(this.directory, { schemaVersion: 1, id, messages: immutableMessages })
      : Promise.resolve();
    this.entries.set(id, {
      checkpoint,
      persistence,
      references: 1,
      lastUsed: ++this.clock,
    });
    this.cleanup();
    await persistence;
    return checkpoint;
  }

  /** Alias emphasizing get-or-create semantics. */
  getOrCreate(messages: readonly Message[]): Promise<Checkpoint> {
    return this.capture(messages);
  }

  get(id: string): Checkpoint | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.checkpoint;
  }

  retain(id: string): Checkpoint {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown checkpoint: ${id}`);
    entry.references += 1;
    entry.lastUsed = ++this.clock;
    return entry.checkpoint;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.references > 0) entry.references -= 1;
    entry.lastUsed = ++this.clock;
    this.cleanup();
  }

  refCount(id: string): number {
    return this.entries.get(id)?.references ?? 0;
  }

  private cleanup(): void {
    if (this.entries.size <= this.maxEntries) return;
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
    for (const [id] of candidates) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(id);
    }
  }
}

async function persistCheckpoint(directory: string, document: CheckpointDocument): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = join(directory, `${document.id}.json`);
  const temporary = join(directory, `.${document.id}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    // Hard-link publication is atomic and never replaces a document another process created.
    await link(temporary, destination);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Checkpoint contains an unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  const members = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
  return `{${members.join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
