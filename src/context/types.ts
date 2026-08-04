import type { Api } from "@oh-my-pi/pi-ai";

import type { JsonValue, Message } from "../core/messages.ts";
import type { SessionEntryInput } from "../sessions/types.ts";

export type ContextFallbackMode = "none" | "snapcompact-images" | "structured-text";

export interface ContextModel {
  readonly provider: string;
  readonly api: Api;
  readonly model: string;
  readonly contextWindow?: number | null;
  readonly supportsImages: boolean;
}

export interface TokenEstimateMetadata {
  readonly estimated: true;
  readonly estimator: "brisk-approximate-v1";
  readonly utf8BytesPerToken: 4;
  readonly messageOverheadTokens: 4;
  readonly imageTokens: 5024;
}

export interface TokenEstimate {
  readonly totalTokens: number;
  readonly textTokens: number;
  readonly toolTokens: number;
  readonly imageTokens: number;
  readonly messageTokens: number;
  readonly imageCount: number;
  readonly metadata: TokenEstimateMetadata;
}

export interface ContextInspection {
  readonly estimatedTokens: number;
  readonly currentUseTokens: number;
  readonly contextWindow: number | null;
  readonly thresholdTokens: number | null;
  readonly nextThresholdTokens: number | null;
  readonly textEstimateTokens: number;
  readonly compactedImageEstimateTokens: number;
  readonly recentRetainedMessages: number;
  readonly compactionCount: number;
  readonly provider: string;
  readonly api: Api;
  readonly model: string;
  readonly fallbackMode: ContextFallbackMode;
  readonly estimate: TokenEstimate;
}

export type CompactionPersistenceInput = Extract<
  SessionEntryInput,
  { readonly type: "compaction" }
>;

export interface ContextManagerOptions {
  readonly model: ContextModel;
  readonly recentTargetTokens?: number;
  /** Disable threshold-triggered compaction while retaining explicit and overflow compaction. */
  readonly automaticCompaction?: boolean;
  /** Provider-ready input trigger. Values above the reserve-based threshold never delay compaction. */
  readonly thresholdPercent?: number;
  readonly maxFrames?: number;
  readonly maxFrameDataBytes?: number;
  readonly rawSourceMaxChars?: number;
  readonly initialMessages?: readonly Message[];
  readonly initialCompactionCount?: number;
  readonly previousCompaction?: {
    readonly summary: string;
    readonly preserveData?: JsonValue;
    readonly rawSource?: string;
    readonly firstKeptIdentity?: string;
    readonly compactedMessageCount?: number;
    readonly retainedMessageCount?: number;
    readonly tokensBefore?: number;
    readonly textTokenEstimate?: number;
    readonly compactedImageTokenEstimate?: number;
    readonly imageCount?: number;
  };
  readonly persist?: (entry: CompactionPersistenceInput) => void | Promise<void>;
  readonly resolveModel?: (model: string) => ContextModel | undefined;
}
