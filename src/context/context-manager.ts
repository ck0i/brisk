import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  ImageContent as PiImageContent,
  Message as PiMessage,
  Usage as PiUsage,
} from "@oh-my-pi/pi-ai";

import type { AgentContextLifecycle } from "../core/agent-loop.ts";
import type {
  AssistantMessage,
  ImageContent,
  JsonValue,
  Message,
  ToolCall,
  Usage,
} from "../core/messages.ts";
import {
  APPROXIMATE_IMAGE_TOKENS,
  DEFAULT_RECENT_TARGET_TOKENS,
  contextThreshold,
  estimateMessages,
  estimateTextTokens,
} from "./estimator.ts";
import { groupToolInteractions, selectRecentMessageStart } from "./grouping.ts";
import type {
  ContextFallbackMode,
  ContextInspection,
  ContextManagerOptions,
  ContextModel,
  TokenEstimate,
} from "./types.ts";

const DEFAULT_RAW_SOURCE_MAX_CHARS = 120_000;

interface ArchiveTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface ArchiveImageBlock extends ImageContent {}

type ArchiveBlock = ArchiveTextBlock | ArchiveImageBlock;

type CompactionReason = "automatic" | "explicit" | "overflow" | "model-switch";

interface ActiveCompaction {
  readonly summary: string;
  readonly preserveData: Readonly<Record<string, JsonValue>>;
  readonly rawSource: string;
  readonly firstKeptIdentity: string;
  readonly compactedMessageCount: number;
  readonly retainedMessageCount: number;
  readonly tokensBefore: number;
  readonly textTokenEstimate: number;
  readonly imageTokenEstimate: number;
  readonly imageCount: number;
  readonly archiveBlocks: readonly ArchiveBlock[];
  readonly renderKey?: string;
}

export class ContextManager implements AgentContextLifecycle {
  private model: ContextModel;
  private readonly recentTargetTokens: number;
  private readonly thresholdPercent: number | undefined;
  private readonly configuredMaxFrames: number | undefined;
  private readonly configuredMaxFrameDataBytes: number | undefined;
  private readonly rawSourceMaxChars: number;
  private readonly persist: ContextManagerOptions["persist"];
  private readonly resolveModel: ContextManagerOptions["resolveModel"];
  private compaction: ActiveCompaction | undefined;
  private lastHistory: readonly Message[];
  private activeContext: readonly Message[];
  private activeEstimate: TokenEstimate;
  private fallbackMode: ContextFallbackMode = "none";
  private compactionCount = 0;
  private revision = 0;
  private renderRequired = false;

  constructor(options: ContextManagerOptions) {
    this.model = options.model;
    this.recentTargetTokens = options.recentTargetTokens ?? DEFAULT_RECENT_TARGET_TOKENS;
    this.thresholdPercent = options.thresholdPercent;
    this.configuredMaxFrames = options.maxFrames;
    this.configuredMaxFrameDataBytes = options.maxFrameDataBytes;
    this.rawSourceMaxChars = options.rawSourceMaxChars ?? DEFAULT_RAW_SOURCE_MAX_CHARS;
    this.persist = options.persist;
    this.resolveModel = options.resolveModel;
    validatePositiveInteger(this.recentTargetTokens, "recentTargetTokens");
    if (this.configuredMaxFrames !== undefined) {
      validatePositiveInteger(this.configuredMaxFrames, "maxFrames");
    }
    if (
      this.configuredMaxFrameDataBytes !== undefined &&
      (!Number.isSafeInteger(this.configuredMaxFrameDataBytes) ||
        this.configuredMaxFrameDataBytes < 0)
    ) {
      throw new RangeError("maxFrameDataBytes must be a non-negative integer");
    }
    validatePositiveInteger(this.rawSourceMaxChars, "rawSourceMaxChars");
    // Validate eagerly even when the model has no usable context metadata.
    contextThreshold(1, this.thresholdPercent);

    this.lastHistory = [...(options.initialMessages ?? [])];
    this.activeContext = this.lastHistory;
    this.activeEstimate = estimateMessages(this.activeContext);

    const previous = options.previousCompaction;
    const preserveData = asJsonRecord(previous?.preserveData) ?? {};
    if (previous) {
      const compactedMessageCount = Math.min(
        previous.compactedMessageCount ?? 0,
        this.lastHistory.length,
      );
      this.compaction = {
        summary: previous.summary,
        preserveData,
        rawSource: boundSource(previous.rawSource ?? "", this.rawSourceMaxChars),
        firstKeptIdentity:
          previous.firstKeptIdentity ??
          messageIdentity(this.lastHistory[compactedMessageCount], compactedMessageCount),
        compactedMessageCount,
        retainedMessageCount:
          previous.retainedMessageCount ?? this.lastHistory.length - compactedMessageCount,
        tokensBefore: previous.tokensBefore ?? estimateMessages(this.lastHistory).totalTokens,
        textTokenEstimate:
          previous.textTokenEstimate ?? estimateTextTokens(previous.rawSource ?? previous.summary),
        imageTokenEstimate: previous.compactedImageTokenEstimate ?? 0,
        imageCount: previous.imageCount ?? 0,
        archiveBlocks: [],
      };
      this.renderRequired = this.model.supportsImages;
      this.compactionCount = options.initialCompactionCount ?? 1;
      validatePositiveInteger(this.compactionCount, "initialCompactionCount");
      this.rebuildActiveContext(this.lastHistory);
    }
  }

  get messages(): readonly Message[] {
    return this.activeContext;
  }

  async prepare(
    messages: readonly Message[],
    model: string,
    signal: AbortSignal,
  ): Promise<readonly Message[]> {
    this.updateModelId(model);
    throwIfAborted(signal);
    this.lastHistory = messages;

    if (this.compaction && this.model.supportsImages && this.needsRender()) {
      await this.performCompaction(messages, signal, "model-switch");
    }

    this.rebuildActiveContext(messages);
    const threshold = this.threshold;
    if (threshold !== undefined && this.activeEstimate.totalTokens >= threshold) {
      await this.performCompaction(messages, signal, "automatic");
      this.rebuildActiveContext(messages);
    }
    throwIfAborted(signal);
    return this.activeContext;
  }

  async forceCompact(
    messages: readonly Message[],
    model: string,
    signal: AbortSignal,
  ): Promise<readonly Message[]> {
    this.updateModelId(model);
    this.lastHistory = messages;
    this.rebuildActiveContext(messages);
    await this.performCompaction(messages, signal, "overflow");
    this.rebuildActiveContext(messages);
    throwIfAborted(signal);
    return this.activeContext;
  }

  async compactNow(
    messages: readonly Message[] = this.lastHistory,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ContextInspection> {
    this.lastHistory = messages;
    this.rebuildActiveContext(messages);
    await this.performCompaction(messages, signal, "explicit");
    this.rebuildActiveContext(messages);
    return this.inspect();
  }

  modelChanged(model: string): void {
    this.updateModelId(model);
  }

  setModel(model: ContextModel): void {
    if (sameModel(this.model, model)) return;
    this.model = model;
    this.revision += 1;
    this.renderRequired =
      this.compaction !== undefined &&
      model.supportsImages &&
      this.compaction.renderKey !== renderKey(model);
    this.rebuildActiveContext(this.lastHistory);
  }

  inspect(messages?: readonly Message[]): ContextInspection {
    if (messages !== undefined) {
      this.lastHistory = messages;
      this.rebuildActiveContext(messages);
    }
    const threshold = this.threshold;
    return {
      estimatedTokens: this.activeEstimate.totalTokens,
      currentUseTokens: this.activeEstimate.totalTokens,
      contextWindow: usableContextWindow(this.model.contextWindow) ?? null,
      thresholdTokens: threshold ?? null,
      nextThresholdTokens: threshold ?? null,
      textEstimateTokens: this.activeEstimate.textTokens,
      compactedImageEstimateTokens: this.compaction?.imageTokenEstimate ?? 0,
      recentRetainedMessages:
        this.compaction === undefined
          ? this.lastHistory.length
          : this.lastHistory.length -
            Math.min(this.compaction.compactedMessageCount, this.lastHistory.length),
      compactionCount: this.compactionCount,
      provider: this.model.provider,
      api: this.model.api,
      model: this.model.model,
      fallbackMode: this.fallbackMode,
      estimate: this.activeEstimate,
    };
  }

  private get threshold(): number | undefined {
    return contextThreshold(this.model.contextWindow, this.thresholdPercent);
  }

  private updateModelId(modelId: string): void {
    if (modelId === this.model.model) return;
    const resolved = this.resolveModel?.(modelId);
    if (resolved) {
      this.setModel(resolved);
      return;
    }
    this.setModel({ ...this.model, model: modelId });
  }

  private needsRender(): boolean {
    const compaction = this.compaction;
    return (
      this.renderRequired ||
      compaction === undefined ||
      compaction.archiveBlocks.length === 0 ||
      compaction.renderKey !== renderKey(this.model)
    );
  }

  private async performCompaction(
    history: readonly Message[],
    signal: AbortSignal,
    reason: CompactionReason,
  ): Promise<void> {
    throwIfAborted(signal);
    if (history.length === 0) return;

    const previousCount = Math.min(this.compaction?.compactedMessageCount ?? 0, history.length);
    const selectionTarget =
      reason === "overflow"
        ? Math.max(1, Math.floor(this.recentTargetTokens / 2))
        : this.recentTargetTokens;
    let nextCount =
      reason === "model-switch"
        ? previousCount
        : Math.max(previousCount, selectRecentMessageStart(history, selectionTarget));
    const groups = groupToolInteractions(history);
    if (nextCount === 0 && groups.length > 1) {
      nextCount = groups.at(-1)?.start ?? 0;
    }

    const rerender =
      reason === "model-switch" || (reason === "overflow" && nextCount === previousCount);
    if (nextCount === previousCount && !rerender) return;
    if (nextCount <= 0 && !this.compaction) return;

    const revision = this.revision;
    const historySnapshot = [...history];
    const recentMessages = historySnapshot.slice(nextCount);
    const messagesToSummarize = rerender ? [] : historySnapshot.slice(previousCount, nextCount);
    const tokensBefore = estimateMessages(historySnapshot).totalTokens;

    // Loading native snapcompact and its renderer is deliberately confined to
    // an actual compaction pass. Below-threshold turns never load the package.
    const snapcompact = await import("@oh-my-pi/snapcompact");
    throwIfAborted(signal);

    const fileOps = snapcompact.createFileOps();
    collectFileOperations(historySnapshot.slice(0, nextCount), fileOps);
    const maxFrameDataBytes =
      this.configuredMaxFrameDataBytes ?? snapcompact.FRAME_DATA_BYTES_BUDGET;
    const providerImages = Math.max(
      0,
      snapcompact.providerImageBudget(this.model.provider) - countImages(recentMessages),
    );
    const shapeTarget = { api: this.model.api, id: this.model.model };
    const shape = snapcompact.resolveShape(shapeTarget);
    const threshold = this.threshold;
    const recentTokens = estimateMessages(recentMessages).totalTokens;
    const tokenFrameLimit =
      threshold === undefined
        ? snapcompact.MAX_FRAMES_DEFAULT
        : Math.max(1, Math.floor(Math.max(0, threshold - recentTokens) / shape.frameTokenEstimate));
    const maxFrames = Math.max(
      1,
      Math.min(
        this.configuredMaxFrames ?? snapcompact.MAX_FRAMES_DEFAULT,
        snapcompact.MAX_FRAMES_DEFAULT,
        Math.max(1, providerImages),
        snapcompact.maxFramesForDataBudget(maxFrameDataBytes),
        tokenFrameLimit,
      ),
    );

    const result = await snapcompact.compact(
      {
        firstKeptEntryId: messageIdentity(historySnapshot[nextCount], nextCount),
        messagesToSummarize,
        turnPrefixMessages: [],
        tokensBefore,
        ...(this.compaction?.summary === undefined
          ? {}
          : { previousSummary: this.compaction.summary }),
        ...(this.compaction?.preserveData === undefined
          ? {}
          : { previousPreserveData: this.compaction.preserveData }),
        fileOps,
      },
      {
        model: shapeTarget,
        maxFrames,
        includeThinking: false,
        convertToLlm: (messages) =>
          toPiArchiveMessages(messages, this.model.api, this.model.provider, this.model.model),
      },
    );
    throwIfAborted(signal);
    if (revision !== this.revision) throw staleCompactionError();

    const preserveData = requireJsonRecord(result.preserveData, "snapcompact preserveData");
    const archive = snapcompact.getPreservedArchive(result.preserveData);
    const blocks = archive
      ? snapcompact.historyBlocks(archive, {
          maxFrameDataBytes: providerImages === 0 ? 0 : maxFrameDataBytes,
        })
      : [];
    const archiveBlocks: ArchiveBlock[] = blocks.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
            ...(block.detail === undefined ? {} : { detail: block.detail }),
          },
    );
    const imageCount = archiveBlocks.filter(
      (block): block is ArchiveImageBlock => block.type === "image",
    ).length;
    const archiveSource = archive ? (snapcompact.archiveSourceText(archive) ?? "") : "";
    const rawSource = boundSource(archiveSource, this.rawSourceMaxChars);
    const textTokenEstimate = estimateTextTokens(rawSource) + estimateTextTokens(result.summary);
    const imageTokenEstimate = imageCount * APPROXIMATE_IMAGE_TOKENS;
    const firstKeptIdentity = result.firstKeptEntryId;
    const retainedMessageCount = historySnapshot.length - nextCount;

    const persistenceEntry = {
      type: "compaction" as const,
      compaction: {
        summary: result.summary,
        preserveData,
        rawSource,
        firstKeptIdentity,
        tokensBefore,
        textTokenEstimate,
        compactedImageTokenEstimate: imageTokenEstimate,
        imageCount,
        compactedMessageCount: nextCount,
        retainedMessageCount,
      },
    };
    throwIfAborted(signal);
    await this.persist?.(persistenceEntry);
    throwIfAborted(signal);
    if (revision !== this.revision) throw staleCompactionError();

    this.compaction = {
      summary: result.summary,
      preserveData,
      rawSource,
      firstKeptIdentity,
      compactedMessageCount: nextCount,
      retainedMessageCount,
      tokensBefore,
      textTokenEstimate,
      imageTokenEstimate,
      imageCount,
      archiveBlocks,
      renderKey: renderKey(this.model),
    };
    this.compactionCount += 1;
    this.renderRequired = false;
  }

  private rebuildActiveContext(history: readonly Message[]): void {
    const compaction = this.compaction;
    if (!compaction) {
      this.activeContext = [...history];
      this.fallbackMode = "none";
      this.activeEstimate = estimateMessages(this.activeContext);
      return;
    }

    const recent = history.slice(Math.min(compaction.compactedMessageCount, history.length));
    if (this.model.supportsImages && compaction.archiveBlocks.length > 0) {
      const archiveMessages: Message[] = [
        {
          role: "user",
          content: [
            "[BRISK SNAPCOMPACT ARCHIVE]",
            "The following ordered text and image blocks are compacted earlier history.",
            compaction.summary,
            "[BEGIN ARCHIVE BLOCKS]",
          ].join("\n"),
        },
      ];
      for (const block of compaction.archiveBlocks) {
        archiveMessages.push(
          block.type === "text"
            ? { role: "user", content: block.text }
            : { role: "user", content: "", images: [block] },
        );
      }
      archiveMessages.push({
        role: "user",
        content: "[END ARCHIVE BLOCKS; RECENT HISTORY FOLLOWS]",
      });
      this.activeContext = [...archiveMessages, ...recent];
      this.fallbackMode = "snapcompact-images";
    } else {
      this.activeContext = [structuredFallback(compaction), ...recent];
      this.fallbackMode = "structured-text";
    }
    this.activeEstimate = estimateMessages(this.activeContext);
  }
}

function structuredFallback(compaction: ActiveCompaction): Message {
  const source =
    compaction.rawSource.length > 0 ? compaction.rawSource : "[archive source unavailable]";
  return {
    role: "user",
    content: [
      "[BRISK COMPACTED HISTORY: TEXT-ONLY FALLBACK]",
      "This deterministic archive preserves earlier user requests, assistant text and decisions, tool calls, command/file arguments, tool results, and failures where present.",
      "[SUMMARY]",
      compaction.summary,
      "[STRUCTURED ARCHIVE: OLDEST HEAD AND NEWEST TAIL RETAINED]",
      source,
      "[END COMPACTED HISTORY; UNCOMPACTED RECENT TAIL FOLLOWS]",
    ].join("\n"),
  };
}

function toPiArchiveMessages(
  messages: readonly Message[],
  api: Api,
  provider: string,
  model: string,
  now = Date.now(),
): PiMessage[] {
  const timestampBase = now - messages.length;
  return messages.map((message, index) => {
    const timestamp = message.timestamp ?? timestampBase + index;
    switch (message.role) {
      case "user": {
        const images: PiImageContent[] = (message.images ?? []).map((image) => ({ ...image }));
        if (images.length === 0) return { role: "user", content: message.content, timestamp };
        return {
          role: "user",
          content: [
            ...(message.content.length === 0
              ? []
              : [{ type: "text" as const, text: message.content }]),
            ...images,
          ],
          timestamp,
        };
      }
      case "assistant":
        return toPiAssistant(message, api, provider, model, timestamp);
      case "tool":
        return {
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.name,
          content: [
            {
              type: "text",
              text: message.isError === true ? `[tool error]\n${message.content}` : message.content,
            },
          ],
          isError: message.isError ?? false,
          timestamp,
        };
    }
  });
}

function toPiAssistant(
  message: AssistantMessage,
  api: Api,
  provider: string,
  model: string,
  timestamp: number,
): PiAssistantMessage {
  const content: PiAssistantMessage["content"] = [];
  if (message.thinking !== undefined)
    content.push({ type: "thinking", thinking: message.thinking });
  if (message.content.length > 0) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: parseArchiveArguments(call),
    });
  }
  return {
    role: "assistant",
    content,
    api: (message.api as Api | undefined) ?? api,
    provider: message.provider ?? provider,
    model: message.model ?? model,
    usage: toPiUsage(message.usage),
    stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: message.timestamp ?? timestamp,
  };
}

function parseArchiveArguments(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Invalid historical arguments remain visible instead of failing compaction.
  }
  return { rawArguments: call.arguments };
}

function toPiUsage(usage: Usage | undefined): PiUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage?.cost ?? 0,
    },
  };
}

function collectFileOperations(
  messages: readonly Message[],
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      const arguments_ = parseArchiveArguments(call);
      const path = firstString(arguments_, ["path", "filePath", "file"]);
      if (!path) continue;
      switch (call.name.toLowerCase()) {
        case "read":
        case "find":
        case "list":
        case "grep":
        case "search":
          fileOps.read.add(path);
          break;
        case "write":
          fileOps.written.add(path);
          break;
        case "edit":
        case "patch":
          fileOps.edited.add(path);
          break;
      }
    }
  }
}

function firstString(
  object: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function countImages(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user") count += message.images?.length ?? 0;
  }
  return count;
}

function boundSource(source: string, maxChars: number): string {
  if (source.length <= maxChars) return source;
  const omitted = source.length - maxChars;
  const notice = `\n[... ${omitted} archive characters omitted; newest tail retained ...]\n`;
  if (notice.length >= maxChars) return source.slice(-maxChars);
  const available = maxChars - notice.length;
  const headChars = Math.floor(available * 0.35);
  const tailChars = available - headChars;
  return `${source.slice(0, headChars)}${notice}${source.slice(-tailChars)}`;
}

function messageIdentity(message: Message | undefined, index: number): string {
  const serialized = message === undefined ? "end" : JSON.stringify(message);
  let hash = 2_166_136_261;
  for (let offset = 0; offset < serialized.length; offset += 1) {
    hash ^= serialized.charCodeAt(offset);
    hash = Math.imul(hash, 16_777_619);
  }
  return `brisk-${index}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function renderKey(model: ContextModel): string {
  return `${model.provider}\u0000${model.api}\u0000${model.model}\u0000${model.contextWindow ?? "unknown"}`;
}

function sameModel(left: ContextModel, right: ContextModel): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model &&
    left.contextWindow === right.contextWindow &&
    left.supportsImages === right.supportsImages
  );
}

function usableContextWindow(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function asJsonRecord(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function requireJsonRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  name: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonRecord(value)) throw new TypeError(`${name} must contain only JSON values`);
  return value;
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function staleCompactionError(): DOMException {
  return new DOMException("Context changed while compaction was running", "AbortError");
}
