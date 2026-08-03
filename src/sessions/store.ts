import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open as openFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../core/messages.ts";
import {
  applyEntryToMetadata,
  makeSessionEntry,
  parseJsonLine,
  parseSessionEntry,
  parseSessionEntryInput,
  parseSessionMetadata,
} from "./codec.ts";
import {
  SessionClosedError,
  SessionFormatError,
  SessionWriteError,
  assertSafeSessionId,
  createSessionMetadata,
  type CreateSessionOptions,
  type InterruptedAssistantDiagnostic,
  type InterruptedToolCall,
  type LoadedSession,
  type LoadedSessionEntry,
  type SessionEntry,
  type SessionEntryInput,
  type SessionFsyncPolicy,
  type SessionLoadDiagnostic,
  type SessionMetadata,
} from "./types.ts";

export interface SessionStoreIO {
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly readText: (path: string) => Promise<string>;
  readonly createTextExclusive: (path: string, data: string) => Promise<void>;
  readonly appendText: (path: string, data: string) => Promise<void>;
  readonly createRecoveryFile: (path: string, data: string) => Promise<void>;
  readonly chmodFile: (path: string) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface SessionStoreOptions {
  readonly sessionsDir: string;
  readonly fsyncPolicy?: SessionFsyncPolicy;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly io?: Partial<SessionStoreIO>;
}

interface WriteState {
  readonly id: string;
  readonly path: string;
  queue: Promise<void>;
  nextSequence: number;
  needsSeparator: boolean;
  failure: SessionWriteError | undefined;
}

interface ReadTranscriptResult {
  readonly loaded: LoadedSession;
  readonly needsSeparator: boolean;
}

interface MutablePartialToolCall {
  readonly index: number;
  id: string;
  name: string;
  arguments: string;
  complete: boolean;
}

interface MutablePartialAssistant {
  startSequence: number;
  content: string;
  thinking: string;
  readonly toolCalls: Map<number, MutablePartialToolCall>;
  reason: "interrupted" | "cancelled" | "error";
  detail: string | undefined;
}

const defaultStoreIO: SessionStoreIO = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  },
  async readText(path) {
    return await readFile(path, "utf8");
  },
  async createTextExclusive(path, data) {
    await writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async appendText(path, data) {
    await appendFile(path, data, { encoding: "utf8", flag: "a", mode: 0o600 });
  },
  async createRecoveryFile(path, data) {
    await writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async chmodFile(path) {
    await chmod(path, 0o600);
  },
  async syncFile(path) {
    const handle = await openFile(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** Serialized append-only access to session transcripts. */
export class SessionStore {
  readonly sessionsDir: string;
  readonly fsyncPolicy: SessionFsyncPolicy;

  private readonly io: SessionStoreIO;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly states = new Map<string, Promise<WriteState>>();
  private readonly pendingWrites = new Map<Promise<readonly SessionEntry[]>, string>();
  private directoryReady: Promise<void> | undefined;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: SessionStoreOptions) {
    this.sessionsDir = options.sessionsDir;
    this.fsyncPolicy = options.fsyncPolicy ?? "flush";
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.io = { ...defaultStoreIO, ...options.io };
  }

  async create(options: CreateSessionOptions): Promise<SessionMetadata> {
    this.assertWritable();
    await this.ensureDirectory();
    const id = options.id ?? this.generateId();
    assertSafeSessionId(id);
    const timestamp = this.now().toISOString();
    const metadata = createSessionMetadata(options, id, timestamp);
    if (!parseSessionMetadata(metadata)) throw new TypeError("Invalid session metadata");
    const entry = makeSessionEntry({ type: "session_metadata", metadata }, 1, timestamp);
    const path = this.pathFor(id);

    try {
      await this.io.createTextExclusive(path, `${JSON.stringify(entry)}\n`);
      if (this.fsyncPolicy === "always") await this.io.syncFile(path);
    } catch (error) {
      throw writeError(id, "Failed to create session transcript", error);
    }

    const state: WriteState = {
      id,
      path,
      queue: Promise.resolve(),
      nextSequence: 2,
      needsSeparator: false,
      failure: undefined,
    };
    this.states.set(id, Promise.resolve(state));
    return metadata;
  }

  async open(id: string): Promise<LoadedSession> {
    assertSafeSessionId(id);
    await this.ensureDirectory();
    const loaded = (await this.readTranscript(id, true)).loaded;
    await this.io.chmodFile(this.pathFor(id));
    return loaded;
  }

  async append(id: string, input: SessionEntryInput): Promise<SessionEntry> {
    const entries = await this.appendBatch(id, [input]);
    const entry = entries[0];
    if (!entry) throw new Error("Session append produced no entry");
    return entry;
  }

  async appendBatch(
    id: string,
    inputs: readonly SessionEntryInput[],
  ): Promise<readonly SessionEntry[]> {
    this.assertWritable();
    assertSafeSessionId(id);

    const validatedInputs: SessionEntryInput[] = [];
    for (const input of inputs) {
      const validated = parseSessionEntryInput(input);
      if (!validated) throw new TypeError("Invalid session entry input");
      if (validated.type === "session_metadata" && validated.metadata.id !== id) {
        throw new TypeError("Session metadata id does not match transcript id");
      }
      validatedInputs.push(validated);
    }
    if (validatedInputs.length === 0) return [];

    const write = (async (): Promise<readonly SessionEntry[]> => {
      const state = await this.stateFor(id);
      return await this.enqueue(state, async () => {
        const timestamp = this.now().toISOString();
        const entries = validatedInputs.map((input, index) =>
          makeSessionEntry(input, state.nextSequence + index, timestamp),
        );
        const separator = state.needsSeparator ? "\n" : "";
        const data = `${separator}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

        try {
          await this.io.appendText(state.path, data);
          if (this.fsyncPolicy === "always") await this.io.syncFile(state.path);
        } catch (error) {
          const failure = writeError(id, "Failed to append session transcript", error);
          state.failure = failure;
          throw failure;
        }

        state.nextSequence += entries.length;
        state.needsSeparator = false;
        return entries;
      });
    })();
    this.pendingWrites.set(write, id);
    try {
      return await write;
    } finally {
      this.pendingWrites.delete(write);
    }
  }

  async flush(id?: string): Promise<void> {
    if (id !== undefined) assertSafeSessionId(id);
    const pending = [...this.pendingWrites.entries()]
      .filter(([, sessionId]) => id === undefined || sessionId === id)
      .map(([write]) => write);
    const pendingResults = await Promise.allSettled(pending);
    let firstError: unknown;
    for (const result of pendingResults) {
      if (result.status === "rejected") firstError ??= result.reason;
    }

    if (id !== undefined) {
      try {
        const state = await this.stateFor(id);
        await this.flushState(state);
      } catch (error) {
        firstError ??= error;
      }
    } else {
      const states = await Promise.all(this.states.values());
      for (const state of states) {
        try {
          await this.flushState(state);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.flush();
      } finally {
        this.closed = true;
        this.closing = false;
      }
    })();
    return await this.closePromise;
  }

  pathFor(id: string): string {
    assertSafeSessionId(id);
    return join(this.sessionsDir, `${id}.jsonl`);
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.directoryReady) {
      this.directoryReady = this.io.ensureDirectory(this.sessionsDir).catch((error: unknown) => {
        this.directoryReady = undefined;
        throw error;
      });
    }
    await this.directoryReady;
  }

  private async stateFor(id: string): Promise<WriteState> {
    let statePromise = this.states.get(id);
    if (!statePromise) {
      statePromise = (async () => {
        await this.ensureDirectory();
        const result = await this.readTranscript(id, true);
        const path = this.pathFor(id);
        await this.io.chmodFile(path);
        return {
          id,
          path,
          queue: Promise.resolve(),
          nextSequence: result.loaded.lastSequence + 1,
          needsSeparator: result.needsSeparator,
          failure: undefined,
        };
      })();
      this.states.set(id, statePromise);
      statePromise.catch(() => {
        if (this.states.get(id) === statePromise) this.states.delete(id);
      });
    }
    return await statePromise;
  }

  private enqueue<T>(state: WriteState, operation: () => Promise<T>): Promise<T> {
    const result = state.queue.then(async () => {
      if (state.failure) throw state.failure;
      return await operation();
    });
    state.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async flushState(state: WriteState): Promise<void> {
    await state.queue;
    if (state.failure) throw state.failure;
    if (this.fsyncPolicy !== "never") {
      try {
        await this.io.syncFile(state.path);
      } catch (error) {
        const failure = writeError(state.id, "Failed to flush session transcript", error);
        state.failure = failure;
        throw failure;
      }
    }
  }

  private async readTranscript(
    id: string,
    preserveTruncatedTail: boolean,
  ): Promise<ReadTranscriptResult> {
    const path = this.pathFor(id);
    let text: string;
    try {
      text = await this.io.readText(path);
    } catch (error) {
      throw new SessionFormatError(`Unable to read session ${id}: ${errorMessage(error)}`);
    }

    const entries: LoadedSessionEntry[] = [];
    const messages: Message[] = [];
    const diagnostics: SessionLoadDiagnostic[] = [];
    const lines = text.split("\n");
    const hasTerminatingNewline = text.endsWith("\n");
    const trailing = hasTerminatingNewline ? undefined : lines.pop();
    if (hasTerminatingNewline) lines.pop();

    if (trailing !== undefined && trailing.length > 0) {
      const line = lines.length + 1;
      let recoveryPath: string | undefined;
      if (preserveTruncatedTail) {
        recoveryPath = join(
          this.sessionsDir,
          `${id}.jsonl.recovery-${Date.now()}-${randomUUID()}.partial`,
        );
        try {
          await this.io.createRecoveryFile(recoveryPath, trailing);
        } catch (error) {
          diagnostics.push({
            kind: "diagnostic_write_failed",
            line,
            message: `Failed to preserve truncated line: ${errorMessage(error)}`,
          });
          recoveryPath = undefined;
        }
      }
      diagnostics.push({
        kind: "truncated_final_line",
        line,
        message: "Ignored unterminated final JSONL record",
        ...(recoveryPath === undefined ? {} : { recoveryPath }),
      });
    }

    let metadata: SessionMetadata | undefined;
    let lastSequence = 0;
    let partial: MutablePartialAssistant | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (line === undefined) continue;
      const json = parseJsonLine(line);
      if (!json.ok) {
        diagnostics.push({
          kind: "malformed_line",
          line: lineNumber,
          message: `Invalid JSON: ${json.error}`,
        });
        continue;
      }
      const parsed = parseSessionEntry(json.value);
      if (!parsed.ok) {
        diagnostics.push({
          kind: "invalid_entry",
          line: lineNumber,
          message: parsed.error,
        });
        continue;
      }
      const entry = parsed.entry;
      if (entry.sequence <= lastSequence) {
        diagnostics.push({
          kind: "sequence_error",
          line: lineNumber,
          message: `Sequence ${entry.sequence} is not greater than ${lastSequence}`,
        });
        continue;
      }
      if (entry.type === "session_metadata" && entry.metadata.id !== id) {
        diagnostics.push({
          kind: "invalid_entry",
          line: lineNumber,
          message: `Metadata id ${entry.metadata.id} does not match transcript id ${id}`,
        });
        continue;
      }

      lastSequence = entry.sequence;
      entries.push(entry);
      metadata = applyEntryToMetadata(metadata, entry);

      if (entry.type === "user_message") messages.push(entry.message);
      else if (entry.type === "assistant_message") {
        messages.push(entry.message);
        partial = undefined;
      } else if (entry.type === "tool_result") messages.push(entry.message);
      else partial = updatePartialAssistant(partial, entry);
    }

    if (!metadata) throw new SessionFormatError(`Session ${id} has no valid metadata entry`);
    const partialAssistant = partial ? finalizePartial(partial) : undefined;
    return {
      loaded: {
        metadata,
        entries,
        messages,
        diagnostics,
        lastSequence,
        ...(partialAssistant === undefined ? {} : { partialAssistant }),
      },
      needsSeparator: trailing !== undefined && trailing.length > 0,
    };
  }

  private assertWritable(): void {
    if (this.closing || this.closed) throw new SessionClosedError();
  }
}

function updatePartialAssistant(
  partial: MutablePartialAssistant | undefined,
  entry: LoadedSessionEntry,
): MutablePartialAssistant | undefined {
  if (entry.type === "assistant_start") return newPartial(entry.sequence);
  if (
    entry.type !== "assistant_text" &&
    entry.type !== "assistant_thinking" &&
    entry.type !== "assistant_tool_call_start" &&
    entry.type !== "assistant_tool_call_delta" &&
    entry.type !== "assistant_tool_call_end" &&
    entry.type !== "cancellation" &&
    entry.type !== "error"
  ) {
    return partial;
  }

  if ((entry.type === "cancellation" || entry.type === "error") && !partial) return undefined;
  const current = partial ?? newPartial(entry.sequence);
  if (entry.type === "assistant_text") current.content += entry.delta;
  else if (entry.type === "assistant_thinking") current.thinking += entry.delta;
  else if (entry.type === "assistant_tool_call_start") {
    current.toolCalls.set(entry.index, {
      index: entry.index,
      id: entry.id,
      name: entry.name,
      arguments: "",
      complete: false,
    });
  } else if (entry.type === "assistant_tool_call_delta") {
    const call = getPartialToolCall(current, entry.index);
    call.arguments += entry.delta;
  } else if (entry.type === "assistant_tool_call_end") {
    getPartialToolCall(current, entry.index).complete = true;
  } else if (entry.type === "cancellation") {
    current.reason = "cancelled";
    current.detail = entry.reason;
  } else {
    current.reason = "error";
    current.detail = entry.message;
  }
  return current;
}

function newPartial(startSequence: number): MutablePartialAssistant {
  return {
    startSequence,
    content: "",
    thinking: "",
    toolCalls: new Map(),
    reason: "interrupted",
    detail: undefined,
  };
}

function getPartialToolCall(
  partial: MutablePartialAssistant,
  index: number,
): MutablePartialToolCall {
  let call = partial.toolCalls.get(index);
  if (!call) {
    call = { index, id: "", name: "", arguments: "", complete: false };
    partial.toolCalls.set(index, call);
  }
  return call;
}

function finalizePartial(partial: MutablePartialAssistant): InterruptedAssistantDiagnostic {
  const toolCalls: InterruptedToolCall[] = [...partial.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({ ...call }));
  return {
    startSequence: partial.startSequence,
    content: partial.content,
    thinking: partial.thinking,
    toolCalls,
    reason: partial.reason,
    ...(partial.detail === undefined ? {} : { detail: partial.detail }),
  };
}

function writeError(sessionId: string, message: string, cause: unknown): SessionWriteError {
  if (cause instanceof SessionWriteError) return cause;
  return new SessionWriteError(sessionId, `${message}: ${errorMessage(cause)}`, { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
