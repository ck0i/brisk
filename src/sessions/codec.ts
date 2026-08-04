import type {
  AssistantMessage,
  ImageContent,
  JsonValue,
  ProviderReplay,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../core/messages.ts";
import {
  SESSION_SCHEMA_VERSION,
  type ChildSessionReference,
  type CompactionMetadata,
  type LoadedSessionEntry,
  type SessionEntry,
  type SessionEntryInput,
  type SessionMetadata,
  type SessionUsageTotals,
  type UnknownSessionEntry,
  isCanonicalWorkspace,
  isSafeSessionId,
} from "./types.ts";

export type EntryParseResult =
  | { readonly ok: true; readonly entry: LoadedSessionEntry }
  | { readonly ok: false; readonly error: string };

interface ParsedEnvelope {
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly rawEntry: Readonly<Record<string, JsonValue>>;
}

export function parseJsonLine(
  line: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    const value: unknown = JSON.parse(line);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export function parseSessionEntry(value: unknown): EntryParseResult {
  const envelope = parseEnvelope(value);
  if (typeof envelope === "string") return { ok: false, error: envelope };

  if (envelope.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return { ok: true, entry: unknownEntry(envelope) };
  }

  const record = value as Readonly<Record<string, unknown>>;
  const base = {
    schemaVersion: envelope.schemaVersion,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    rawEntry: envelope.rawEntry,
  };

  switch (envelope.type) {
    case "session_metadata": {
      const metadata = parseSessionMetadata(record.metadata);
      if (!metadata) return invalid("session_metadata.metadata");
      return { ok: true, entry: { ...base, type: "session_metadata", metadata } };
    }
    case "user_message": {
      const message = parseUserMessage(record.message);
      if (!message) return invalid("user_message.message");
      return { ok: true, entry: { ...base, type: "user_message", message } };
    }
    case "assistant_start": {
      if (!isOptionalString(record.responseId)) return invalid("assistant_start.responseId");
      if (!isOptionalString(record.provider)) return invalid("assistant_start.provider");
      if (!isOptionalString(record.api)) return invalid("assistant_start.api");
      if (!isOptionalString(record.model)) return invalid("assistant_start.model");
      return {
        ok: true,
        entry: {
          ...base,
          type: "assistant_start",
          ...(record.responseId === undefined ? {} : { responseId: record.responseId }),
          ...(record.provider === undefined ? {} : { provider: record.provider }),
          ...(record.api === undefined ? {} : { api: record.api }),
          ...(record.model === undefined ? {} : { model: record.model }),
        },
      };
    }
    case "assistant_text":
      if (typeof record.delta !== "string") return invalid("assistant_text.delta");
      return { ok: true, entry: { ...base, type: "assistant_text", delta: record.delta } };
    case "assistant_thinking":
      if (typeof record.delta !== "string") return invalid("assistant_thinking.delta");
      return { ok: true, entry: { ...base, type: "assistant_thinking", delta: record.delta } };
    case "assistant_tool_call_start":
      if (!isNonnegativeInteger(record.index)) return invalid("assistant_tool_call_start.index");
      if (typeof record.id !== "string") return invalid("assistant_tool_call_start.id");
      if (typeof record.name !== "string") return invalid("assistant_tool_call_start.name");
      return {
        ok: true,
        entry: {
          ...base,
          type: "assistant_tool_call_start",
          index: record.index,
          id: record.id,
          name: record.name,
        },
      };
    case "assistant_tool_call_delta":
      if (!isNonnegativeInteger(record.index)) return invalid("assistant_tool_call_delta.index");
      if (typeof record.delta !== "string") return invalid("assistant_tool_call_delta.delta");
      return {
        ok: true,
        entry: {
          ...base,
          type: "assistant_tool_call_delta",
          index: record.index,
          delta: record.delta,
        },
      };
    case "assistant_tool_call_end":
      if (!isNonnegativeInteger(record.index)) return invalid("assistant_tool_call_end.index");
      return {
        ok: true,
        entry: { ...base, type: "assistant_tool_call_end", index: record.index },
      };
    case "assistant_message": {
      const message = parseAssistantMessage(record.message);
      if (!message) return invalid("assistant_message.message");
      return { ok: true, entry: { ...base, type: "assistant_message", message } };
    }
    case "tool_result": {
      const message = parseToolResultMessage(record.message);
      if (!message) return invalid("tool_result.message");
      return { ok: true, entry: { ...base, type: "tool_result", message } };
    }
    case "usage": {
      const usage = parseUsage(record.usage);
      if (!usage) return invalid("usage.usage");
      return { ok: true, entry: { ...base, type: "usage", usage } };
    }
    case "compaction": {
      const compaction = parseCompaction(record.compaction);
      if (!compaction) return invalid("compaction.compaction");
      return { ok: true, entry: { ...base, type: "compaction", compaction } };
    }
    case "model_change":
      if (!isNonemptyString(record.provider)) return invalid("model_change.provider");
      if (!isNonemptyString(record.model)) return invalid("model_change.model");
      return {
        ok: true,
        entry: {
          ...base,
          type: "model_change",
          provider: record.provider,
          model: record.model,
        },
      };
    case "child_session": {
      const child = parseChildReference(record.child);
      if (!child) return invalid("child_session.child");
      return { ok: true, entry: { ...base, type: "child_session", child } };
    }
    case "mode_state":
      if (!isNonemptyString(record.key)) return invalid("mode_state.key");
      if (!isJsonValue(record.value)) return invalid("mode_state.value");
      return {
        ok: true,
        entry: { ...base, type: "mode_state", key: record.key, value: record.value },
      };
    case "cancellation":
      if (!isOptionalString(record.reason)) return invalid("cancellation.reason");
      return {
        ok: true,
        entry: {
          ...base,
          type: "cancellation",
          ...(record.reason === undefined ? {} : { reason: record.reason }),
        },
      };
    case "error":
      if (typeof record.message !== "string") return invalid("error.message");
      if (!isOptionalString(record.errorKind)) return invalid("error.errorKind");
      if (!isOptionalBoolean(record.retryable)) return invalid("error.retryable");
      return {
        ok: true,
        entry: {
          ...base,
          type: "error",
          message: record.message,
          ...(record.errorKind === undefined ? {} : { errorKind: record.errorKind }),
          ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
        },
      };
    default:
      return { ok: true, entry: unknownEntry(envelope) };
  }
}

export function makeSessionEntry(
  value: unknown,
  sequence: number,
  timestamp: string,
): SessionEntry {
  const input = parseSessionEntryInput(value);
  if (!input) throw new TypeError("Invalid session entry input");
  if (!isPositiveInteger(sequence)) throw new TypeError("Session entry sequence must be positive");
  if (!isIsoTimestamp(timestamp)) throw new TypeError("Session entry timestamp must be ISO-8601");
  return { schemaVersion: SESSION_SCHEMA_VERSION, sequence, timestamp, ...input };
}

export function parseSessionEntryInput(value: unknown): SessionEntryInput | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "session_metadata": {
      const metadata = parseSessionMetadata(value.metadata);
      return metadata ? { type: "session_metadata", metadata } : undefined;
    }
    case "user_message": {
      const message = parseUserMessage(value.message);
      return message ? { type: "user_message", message } : undefined;
    }
    case "assistant_start":
      if (
        !isOptionalString(value.responseId) ||
        !isOptionalString(value.provider) ||
        !isOptionalString(value.api) ||
        !isOptionalString(value.model)
      ) {
        return undefined;
      }
      return {
        type: "assistant_start",
        ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.api === undefined ? {} : { api: value.api }),
        ...(value.model === undefined ? {} : { model: value.model }),
      };
    case "assistant_text":
      return typeof value.delta === "string"
        ? { type: "assistant_text", delta: value.delta }
        : undefined;
    case "assistant_thinking":
      return typeof value.delta === "string"
        ? { type: "assistant_thinking", delta: value.delta }
        : undefined;
    case "assistant_tool_call_start":
      return isNonnegativeInteger(value.index) &&
        typeof value.id === "string" &&
        typeof value.name === "string"
        ? {
            type: "assistant_tool_call_start",
            index: value.index,
            id: value.id,
            name: value.name,
          }
        : undefined;
    case "assistant_tool_call_delta":
      return isNonnegativeInteger(value.index) && typeof value.delta === "string"
        ? { type: "assistant_tool_call_delta", index: value.index, delta: value.delta }
        : undefined;
    case "assistant_tool_call_end":
      return isNonnegativeInteger(value.index)
        ? { type: "assistant_tool_call_end", index: value.index }
        : undefined;
    case "assistant_message": {
      const message = parseAssistantMessage(value.message);
      return message ? { type: "assistant_message", message } : undefined;
    }
    case "tool_result": {
      const message = parseToolResultMessage(value.message);
      return message ? { type: "tool_result", message } : undefined;
    }
    case "usage": {
      const usage = parseUsage(value.usage);
      return usage ? { type: "usage", usage } : undefined;
    }
    case "compaction": {
      const compaction = parseCompaction(value.compaction);
      return compaction ? { type: "compaction", compaction } : undefined;
    }
    case "model_change":
      return isNonemptyString(value.provider) && isNonemptyString(value.model)
        ? { type: "model_change", provider: value.provider, model: value.model }
        : undefined;
    case "child_session": {
      const child = parseChildReference(value.child);
      return child ? { type: "child_session", child } : undefined;
    }
    case "mode_state":
      return isNonemptyString(value.key) && isJsonValue(value.value)
        ? { type: "mode_state", key: value.key, value: value.value }
        : undefined;
    case "cancellation":
      return isOptionalString(value.reason)
        ? {
            type: "cancellation",
            ...(value.reason === undefined ? {} : { reason: value.reason }),
          }
        : undefined;
    case "error":
      return typeof value.message === "string" &&
        isOptionalString(value.errorKind) &&
        isOptionalBoolean(value.retryable)
        ? {
            type: "error",
            message: value.message,
            ...(value.errorKind === undefined ? {} : { errorKind: value.errorKind }),
            ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
          }
        : undefined;
    default:
      return undefined;
  }
}

export function parseSessionMetadata(value: unknown): SessionMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (!isSafeSessionIdValue(value.id)) return undefined;
  if (!isNonemptyString(value.title)) return undefined;
  if (typeof value.workspace !== "string" || !isCanonicalWorkspace(value.workspace))
    return undefined;
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return undefined;
  if (!isNonemptyString(value.selectedProvider) || !isNonemptyString(value.selectedModel)) {
    return undefined;
  }
  const usageTotals = parseUsageTotals(value.usageTotals);
  if (!usageTotals) return undefined;
  if (!isNonnegativeInteger(value.compactionCount)) return undefined;
  if (!Array.isArray(value.childRefs)) return undefined;
  const childRefs: ChildSessionReference[] = [];
  for (const childValue of value.childRefs) {
    const child = parseChildReference(childValue);
    if (!child) return undefined;
    childRefs.push(child);
  }
  if (value.transcriptFilename !== `${value.id}.jsonl`) return undefined;
  if (!isPositiveInteger(value.transcriptVersion)) return undefined;
  return {
    id: value.id,
    title: value.title,
    workspace: value.workspace,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    selectedProvider: value.selectedProvider,
    selectedModel: value.selectedModel,
    usageTotals,
    compactionCount: value.compactionCount,
    childRefs,
    transcriptFilename: value.transcriptFilename,
    transcriptVersion: value.transcriptVersion,
  };
}

export function applyEntryToMetadata(
  current: SessionMetadata | undefined,
  entry: LoadedSessionEntry,
): SessionMetadata | undefined {
  let next = current;
  if (entry.type === "session_metadata") {
    next = entry.metadata;
  } else if (next && entry.type === "model_change") {
    next = { ...next, selectedProvider: entry.provider, selectedModel: entry.model };
  } else if (next && entry.type === "usage") {
    next = { ...next, usageTotals: addUsage(next.usageTotals, entry.usage) };
  } else if (next && entry.type === "compaction") {
    next = { ...next, compactionCount: next.compactionCount + 1 };
  } else if (next && entry.type === "child_session") {
    const childRefs = next.childRefs.filter((child) => child.sessionId !== entry.child.sessionId);
    next = { ...next, childRefs: [...childRefs, entry.child] };
  }

  if (next && entry.timestamp > next.updatedAt) next = { ...next, updatedAt: entry.timestamp };
  return next;
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function parseEnvelope(value: unknown): ParsedEnvelope | string {
  if (!isRecord(value)) return "entry must be an object";
  if (!isPositiveInteger(value.schemaVersion)) return "schemaVersion must be a positive integer";
  if (!isPositiveInteger(value.sequence)) return "sequence must be a positive integer";
  if (!isIsoTimestamp(value.timestamp)) return "timestamp must be an ISO-8601 string";
  if (!isNonemptyString(value.type)) return "type must be a non-empty string";
  if (!isJsonValue(value)) return "entry must contain only JSON values";
  return {
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    timestamp: value.timestamp,
    type: value.type,
    rawEntry: value,
  };
}

function unknownEntry(envelope: ParsedEnvelope): UnknownSessionEntry {
  return {
    type: "unknown",
    originalType: envelope.type,
    schemaVersion: envelope.schemaVersion,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    rawEntry: envelope.rawEntry,
  };
}

function invalid(field: string): EntryParseResult {
  return { ok: false, error: `invalid ${field}` };
}

function parseUserMessage(value: unknown): UserMessage | undefined {
  if (!isRecord(value) || value.role !== "user" || typeof value.content !== "string") {
    return undefined;
  }
  if (!isOptionalFiniteNumber(value.timestamp)) return undefined;
  if (value.internal !== undefined && value.internal !== "goal-control") return undefined;
  if (value.images !== undefined && !Array.isArray(value.images)) return undefined;
  const images: ImageContent[] = [];
  for (const imageValue of value.images ?? []) {
    const image = parseImageContent(imageValue);
    if (!image) return undefined;
    images.push(image);
  }
  return {
    role: "user",
    content: value.content,
    ...(images.length === 0 ? {} : { images }),
    ...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
    ...(value.internal === undefined ? {} : { internal: value.internal }),
  };
}

function parseImageContent(value: unknown): ImageContent | undefined {
  if (!isRecord(value) || value.type !== "image") return undefined;
  if (typeof value.data !== "string" || value.data.length === 0) return undefined;
  if (typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/")) return undefined;
  if (
    value.detail !== undefined &&
    value.detail !== "auto" &&
    value.detail !== "low" &&
    value.detail !== "high" &&
    value.detail !== "original"
  ) {
    return undefined;
  }
  return {
    type: "image",
    data: value.data,
    mimeType: value.mimeType,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function parseAssistantMessage(value: unknown): AssistantMessage | undefined {
  if (!isRecord(value) || value.role !== "assistant" || typeof value.content !== "string") {
    return undefined;
  }
  if (!isOptionalString(value.thinking)) return undefined;
  if (!Array.isArray(value.toolCalls)) return undefined;
  const toolCalls: ToolCall[] = [];
  for (const toolCallValue of value.toolCalls) {
    const toolCall = parseToolCall(toolCallValue);
    if (!toolCall) return undefined;
    toolCalls.push(toolCall);
  }
  const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
  if (value.usage !== undefined && !usage) return undefined;
  const providerReplay =
    value.providerReplay === undefined ? undefined : parseProviderReplay(value.providerReplay);
  if (value.providerReplay !== undefined && !providerReplay) return undefined;
  if (!isOptionalString(value.provider)) return undefined;
  if (!isOptionalString(value.api)) return undefined;
  if (!isOptionalString(value.model)) return undefined;
  if (!isOptionalFiniteNumber(value.timestamp)) return undefined;
  return {
    role: "assistant",
    content: value.content,
    toolCalls,
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    ...(usage === undefined ? {} : { usage }),
    ...(providerReplay === undefined ? {} : { providerReplay }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.api === undefined ? {} : { api: value.api }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
  };
}

function parseProviderReplay(value: unknown): ProviderReplay | undefined {
  if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isJsonValue)) {
    return undefined;
  }
  if (!isOptionalString(value.responseId)) return undefined;
  if (value.providerPayload !== undefined && !isJsonValue(value.providerPayload)) return undefined;
  if (
    value.stopReason !== undefined &&
    value.stopReason !== "stop" &&
    value.stopReason !== "length" &&
    value.stopReason !== "toolUse" &&
    value.stopReason !== "error" &&
    value.stopReason !== "aborted"
  ) {
    return undefined;
  }
  return {
    content: value.content,
    ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
    ...(value.providerPayload === undefined ? {} : { providerPayload: value.providerPayload }),
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
  };
}

function parseToolCall(value: unknown): ToolCall | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  if (typeof value.arguments !== "string") return undefined;
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function parseToolResultMessage(value: unknown): ToolResultMessage | undefined {
  if (!isRecord(value) || value.role !== "tool") return undefined;
  if (typeof value.toolCallId !== "string" || typeof value.name !== "string") return undefined;
  if (typeof value.content !== "string" || !isOptionalBoolean(value.isError)) return undefined;
  if (!isOptionalFiniteNumber(value.timestamp)) return undefined;
  return {
    role: "tool",
    toolCallId: value.toolCallId,
    name: value.name,
    content: value.content,
    ...(value.isError === undefined ? {} : { isError: value.isError }),
    ...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
  };
}

export function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonnegativeFiniteNumber(value.inputTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.outputTokens)) return undefined;
  if (!isOptionalNonnegativeNumber(value.cacheReadTokens)) return undefined;
  if (!isOptionalNonnegativeNumber(value.cacheWriteTokens)) return undefined;
  if (!isOptionalNonnegativeNumber(value.totalTokens)) return undefined;
  if (!isOptionalNonnegativeNumber(value.cost)) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.cacheReadTokens }),
    ...(value.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: value.cacheWriteTokens }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
    ...(value.cost === undefined ? {} : { cost: value.cost }),
  };
}

function parseUsageTotals(value: unknown): SessionUsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonnegativeFiniteNumber(value.inputTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.outputTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.cacheReadTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.cacheWriteTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.totalTokens)) return undefined;
  if (!isNonnegativeFiniteNumber(value.cost)) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    totalTokens: value.totalTokens,
    cost: value.cost,
  };
}

function parseCompaction(value: unknown): CompactionMetadata | undefined {
  if (!isRecord(value) || typeof value.summary !== "string") return undefined;
  if (value.preserveData !== undefined && !isJsonValue(value.preserveData)) return undefined;
  if (!isOptionalString(value.rawSource)) return undefined;
  if (!isOptionalString(value.firstKeptIdentity)) return undefined;
  if (!isOptionalNonnegativeNumber(value.tokensBefore)) return undefined;
  if (!isOptionalNonnegativeNumber(value.textTokenEstimate)) return undefined;
  if (!isOptionalNonnegativeNumber(value.compactedImageTokenEstimate)) return undefined;
  if (!isOptionalNonnegativeInteger(value.imageCount)) return undefined;
  if (!isOptionalNonnegativeInteger(value.compactedMessageCount)) return undefined;
  if (!isOptionalNonnegativeInteger(value.retainedMessageCount)) return undefined;
  return {
    summary: value.summary,
    ...(value.preserveData === undefined ? {} : { preserveData: value.preserveData }),
    ...(value.rawSource === undefined ? {} : { rawSource: value.rawSource }),
    ...(value.firstKeptIdentity === undefined
      ? {}
      : { firstKeptIdentity: value.firstKeptIdentity }),
    ...(value.tokensBefore === undefined ? {} : { tokensBefore: value.tokensBefore }),
    ...(value.textTokenEstimate === undefined
      ? {}
      : { textTokenEstimate: value.textTokenEstimate }),
    ...(value.compactedImageTokenEstimate === undefined
      ? {}
      : { compactedImageTokenEstimate: value.compactedImageTokenEstimate }),
    ...(value.imageCount === undefined ? {} : { imageCount: value.imageCount }),
    ...(value.compactedMessageCount === undefined
      ? {}
      : { compactedMessageCount: value.compactedMessageCount }),
    ...(value.retainedMessageCount === undefined
      ? {}
      : { retainedMessageCount: value.retainedMessageCount }),
  };
}

function parseChildReference(value: unknown): ChildSessionReference | undefined {
  if (!isRecord(value) || !isSafeSessionIdValue(value.sessionId)) return undefined;
  if (!isOptionalString(value.title)) return undefined;
  if (value.createdAt !== undefined && !isIsoTimestamp(value.createdAt)) return undefined;
  return {
    sessionId: value.sessionId,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
  };
}

function addUsage(totals: SessionUsageTotals, usage: Usage): SessionUsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    totalTokens:
      totals.totalTokens +
      (usage.totalTokens ??
        usage.inputTokens +
          usage.outputTokens +
          (usage.cacheReadTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0)),
    cost: totals.cost + (usage.cost ?? 0),
  };
}

function isSafeSessionIdValue(value: unknown): value is string {
  return typeof value === "string" && isSafeSessionId(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalNonnegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || isNonnegativeFiniteNumber(value);
}

function isOptionalNonnegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonnegativeInteger(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
