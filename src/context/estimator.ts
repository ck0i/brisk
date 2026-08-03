import type { Message } from "../core/messages.ts";
import type { TokenEstimate, TokenEstimateMetadata } from "./types.ts";

export const DEFAULT_RECENT_TARGET_TOKENS = 20_000;
export const MINIMUM_CONTEXT_RESERVE_TOKENS = 16_384;
export const DEFAULT_CONTEXT_RESERVE_PERCENT = 0.15;
export const APPROXIMATE_IMAGE_TOKENS = 5024;
export const MESSAGE_OVERHEAD_TOKENS = 4;

export const TOKEN_ESTIMATE_METADATA: TokenEstimateMetadata = {
  estimated: true,
  estimator: "brisk-approximate-v1",
  utf8BytesPerToken: 4,
  messageOverheadTokens: MESSAGE_OVERHEAD_TOKENS,
  imageTokens: APPROXIMATE_IMAGE_TOKENS,
};

/** Deterministic UTF-8 approximation. This intentionally does not call a model tokenizer. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / TOKEN_ESTIMATE_METADATA.utf8BytesPerToken);
}

export function estimateMessages(messages: readonly Message[]): TokenEstimate {
  let textTokens = 0;
  let toolTokens = 0;
  let imageCount = 0;

  for (const message of messages) {
    switch (message.role) {
      case "user":
        textTokens += estimateTextTokens(message.content);
        imageCount += message.images?.length ?? 0;
        for (const image of message.images ?? []) {
          toolTokens += estimateTextTokens(image.mimeType) + (image.detail === undefined ? 0 : 1);
        }
        break;
      case "assistant":
        textTokens += estimateTextTokens(message.content);
        if (message.thinking !== undefined) textTokens += estimateTextTokens(message.thinking);
        for (const call of message.toolCalls) {
          toolTokens +=
            12 +
            estimateTextTokens(call.id) +
            estimateTextTokens(call.name) +
            estimateTextTokens(call.arguments);
        }
        break;
      case "tool":
        textTokens += estimateTextTokens(message.content);
        toolTokens += 8 + estimateTextTokens(message.toolCallId) + estimateTextTokens(message.name);
        if (message.isError === true) toolTokens += 1;
        break;
    }
  }

  const messageTokens = messages.length * MESSAGE_OVERHEAD_TOKENS;
  const imageTokens = imageCount * APPROXIMATE_IMAGE_TOKENS;
  return {
    totalTokens: textTokens + toolTokens + imageTokens + messageTokens,
    textTokens,
    toolTokens,
    imageTokens,
    messageTokens,
    imageCount,
    metadata: TOKEN_ESTIMATE_METADATA,
  };
}

/**
 * Trigger point leaves the larger of 15% and 16,384 tokens for output and
 * provider overhead. A configured percentage can only trigger earlier.
 */
export function contextThreshold(
  contextWindow: number | null | undefined,
  thresholdPercent?: number,
): number | undefined {
  if (
    contextWindow === null ||
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return undefined;
  }
  if (
    thresholdPercent !== undefined &&
    (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 1)
  ) {
    throw new RangeError("thresholdPercent must be greater than 0 and at most 1");
  }

  const reserve = Math.max(
    Math.ceil(contextWindow * DEFAULT_CONTEXT_RESERVE_PERCENT),
    MINIMUM_CONTEXT_RESERVE_TOKENS,
  );
  const reserveThreshold = Math.floor(contextWindow - reserve);
  if (thresholdPercent === undefined) return reserveThreshold;
  return Math.min(reserveThreshold, Math.floor(contextWindow * thresholdPercent));
}
