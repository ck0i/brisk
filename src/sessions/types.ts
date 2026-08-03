import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import type {
  AssistantMessage,
  JsonValue,
  Message,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../core/messages.ts";

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_TRANSCRIPT_VERSION = 1;
export const SESSION_INDEX_SCHEMA_VERSION = 1;

export type SessionFsyncPolicy = "never" | "flush" | "always";

export interface SessionUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface ChildSessionReference {
  readonly sessionId: string;
  readonly title?: string;
  readonly createdAt?: string;
}

export interface SessionMetadata {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly usageTotals: SessionUsageTotals;
  readonly compactionCount: number;
  readonly childRefs: readonly ChildSessionReference[];
  readonly transcriptFilename: string;
  readonly transcriptVersion: number;
}

export type SessionIndexRecord = SessionMetadata;

export interface CreateSessionOptions {
  readonly id?: string;
  readonly title: string;
  readonly workspace: string;
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly createdAt?: string;
}

export interface CompactionMetadata {
  readonly summary: string;
  readonly preserveData?: JsonValue;
  readonly compactedMessageCount?: number;
  readonly retainedMessageCount?: number;
}

export interface SessionEntryBase {
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly timestamp: string;
  /** exact parsed JSON, retained so unrecognized future fields remain inspectable */
  readonly rawEntry?: Readonly<Record<string, JsonValue>>;
}

export interface SessionMetadataEntry extends SessionEntryBase {
  readonly type: "session_metadata";
  readonly metadata: SessionMetadata;
}

export interface UserMessageEntry extends SessionEntryBase {
  readonly type: "user_message";
  readonly message: UserMessage;
}

export interface AssistantStartEntry extends SessionEntryBase {
  readonly type: "assistant_start";
  readonly responseId?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly model?: string;
}

export interface AssistantTextEntry extends SessionEntryBase {
  readonly type: "assistant_text";
  readonly delta: string;
}

export interface AssistantThinkingEntry extends SessionEntryBase {
  readonly type: "assistant_thinking";
  readonly delta: string;
}

export interface AssistantToolCallStartEntry extends SessionEntryBase {
  readonly type: "assistant_tool_call_start";
  readonly index: number;
  readonly id: string;
  readonly name: string;
}

export interface AssistantToolCallDeltaEntry extends SessionEntryBase {
  readonly type: "assistant_tool_call_delta";
  readonly index: number;
  readonly delta: string;
}

export interface AssistantToolCallEndEntry extends SessionEntryBase {
  readonly type: "assistant_tool_call_end";
  readonly index: number;
}

export interface AssistantMessageEntry extends SessionEntryBase {
  readonly type: "assistant_message";
  readonly message: AssistantMessage;
}

export interface ToolResultEntry extends SessionEntryBase {
  readonly type: "tool_result";
  readonly message: ToolResultMessage;
}

export interface UsageEntry extends SessionEntryBase {
  readonly type: "usage";
  readonly usage: Usage;
}

export interface CompactionEntry extends SessionEntryBase {
  readonly type: "compaction";
  readonly compaction: CompactionMetadata;
}

export interface ModelChangeEntry extends SessionEntryBase {
  readonly type: "model_change";
  readonly provider: string;
  readonly model: string;
}

export interface ChildSessionEntry extends SessionEntryBase {
  readonly type: "child_session";
  readonly child: ChildSessionReference;
}

export interface CancellationEntry extends SessionEntryBase {
  readonly type: "cancellation";
  readonly reason?: string;
}

export interface ErrorEntry extends SessionEntryBase {
  readonly type: "error";
  readonly message: string;
  readonly errorKind?: string;
  readonly retryable?: boolean;
}

export type SessionEntry =
  | SessionMetadataEntry
  | UserMessageEntry
  | AssistantStartEntry
  | AssistantTextEntry
  | AssistantThinkingEntry
  | AssistantToolCallStartEntry
  | AssistantToolCallDeltaEntry
  | AssistantToolCallEndEntry
  | AssistantMessageEntry
  | ToolResultEntry
  | UsageEntry
  | CompactionEntry
  | ModelChangeEntry
  | ChildSessionEntry
  | CancellationEntry
  | ErrorEntry;

export interface UnknownSessionEntry extends SessionEntryBase {
  readonly type: "unknown";
  readonly originalType: string;
  readonly rawEntry: Readonly<Record<string, JsonValue>>;
}

export type LoadedSessionEntry = SessionEntry | UnknownSessionEntry;

export type SessionEntryInput =
  | { readonly type: "session_metadata"; readonly metadata: SessionMetadata }
  | { readonly type: "user_message"; readonly message: UserMessage }
  | {
      readonly type: "assistant_start";
      readonly responseId?: string;
      readonly provider?: string;
      readonly api?: string;
      readonly model?: string;
    }
  | { readonly type: "assistant_text"; readonly delta: string }
  | { readonly type: "assistant_thinking"; readonly delta: string }
  | {
      readonly type: "assistant_tool_call_start";
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  | { readonly type: "assistant_tool_call_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "assistant_tool_call_end"; readonly index: number }
  | { readonly type: "assistant_message"; readonly message: AssistantMessage }
  | { readonly type: "tool_result"; readonly message: ToolResultMessage }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "compaction"; readonly compaction: CompactionMetadata }
  | { readonly type: "model_change"; readonly provider: string; readonly model: string }
  | { readonly type: "child_session"; readonly child: ChildSessionReference }
  | { readonly type: "cancellation"; readonly reason?: string }
  | {
      readonly type: "error";
      readonly message: string;
      readonly errorKind?: string;
      readonly retryable?: boolean;
    };

export interface InterruptedToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly complete: boolean;
}

export interface InterruptedAssistantDiagnostic {
  readonly startSequence: number;
  readonly content: string;
  readonly thinking: string;
  readonly toolCalls: readonly InterruptedToolCall[];
  readonly reason: "interrupted" | "cancelled" | "error";
  readonly detail?: string;
}

export type SessionLoadDiagnosticKind =
  | "truncated_final_line"
  | "malformed_line"
  | "invalid_entry"
  | "sequence_error"
  | "diagnostic_write_failed";

export interface SessionLoadDiagnostic {
  readonly kind: SessionLoadDiagnosticKind;
  readonly line: number;
  readonly message: string;
  readonly recoveryPath?: string;
}

export interface LoadedSession {
  readonly metadata: SessionMetadata;
  readonly entries: readonly LoadedSessionEntry[];
  readonly messages: readonly Message[];
  readonly diagnostics: readonly SessionLoadDiagnostic[];
  readonly lastSequence: number;
  readonly partialAssistant?: InterruptedAssistantDiagnostic;
}

export interface SessionAppendResult {
  readonly entries: readonly SessionEntry[];
}

export interface RepositoryAppendResult extends SessionAppendResult {
  readonly indexError?: Error;
}

export interface RepositoryCreateResult {
  readonly metadata: SessionMetadata;
  readonly indexError?: Error;
}

export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`Invalid session id: ${JSON.stringify(id)}`);
    this.name = "InvalidSessionIdError";
  }
}

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFormatError";
  }
}

export class SessionWriteError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SessionWriteError";
    this.sessionId = sessionId;
  }
}

export class SessionClosedError extends Error {
  constructor() {
    super("Session store is closed");
    this.name = "SessionClosedError";
  }
}

export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export function assertSafeSessionId(id: string): void {
  if (!isSafeSessionId(id)) throw new InvalidSessionIdError(id);
}

export function canonicalWorkspace(workspace: string): string {
  if (workspace.includes("\0")) throw new TypeError("Workspace path contains a NUL byte");
  const absolute = resolve(workspace);
  try {
    return realpathSync.native(absolute);
  } catch {
    // historical sessions remain useful when their workspace no longer exists
    return absolute;
  }
}

export function isCanonicalWorkspace(workspace: string): boolean {
  return !workspace.includes("\0") && isAbsolute(workspace) && normalize(workspace) === workspace;
}

export function emptyUsageTotals(): SessionUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

export function createSessionMetadata(
  options: CreateSessionOptions,
  id: string,
  now: string,
): SessionMetadata {
  assertSafeSessionId(id);
  const createdAt = options.createdAt ?? now;
  return {
    id,
    title: options.title,
    workspace: canonicalWorkspace(options.workspace),
    createdAt,
    updatedAt: createdAt,
    selectedProvider: options.selectedProvider,
    selectedModel: options.selectedModel,
    usageTotals: emptyUsageTotals(),
    compactionCount: 0,
    childRefs: [],
    transcriptFilename: `${id}.jsonl`,
    transcriptVersion: SESSION_TRANSCRIPT_VERSION,
  };
}
