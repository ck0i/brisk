import type { Message } from "../core/messages.ts";
import { estimateMessages } from "./estimator.ts";

export interface MessageGroup {
  readonly start: number;
  readonly end: number;
  readonly messages: readonly Message[];
}

/**
 * Partition history into chronological atomic ranges. An assistant tool call
 * and every matching result share a range, including intervening messages, so
 * retaining a suffix can never retain a result without its call.
 */
export function groupToolInteractions(messages: readonly Message[]): readonly MessageGroup[] {
  if (messages.length === 0) return [];

  const callOwner = new Map<string, number>();
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      for (const call of message.toolCalls) callOwner.set(call.id, index);
    } else if (message.role === "tool") {
      const owner = callOwner.get(message.toolCallId);
      if (owner !== undefined) ranges.push({ start: owner, end: index + 1 });
    }
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const groups: MessageGroup[] = [];
  let index = 0;
  let rangeIndex = 0;
  while (index < messages.length) {
    const range = merged[rangeIndex];
    if (range && range.start === index) {
      groups.push({ start: index, end: range.end, messages: messages.slice(index, range.end) });
      index = range.end;
      rangeIndex += 1;
      continue;
    }
    if (range && range.start < index) {
      rangeIndex += 1;
      continue;
    }
    groups.push({ start: index, end: index + 1, messages: messages.slice(index, index + 1) });
    index += 1;
  }
  return groups;
}

/** Select a complete-group suffix nearest the requested token target. */
export function selectRecentMessageStart(
  messages: readonly Message[],
  targetTokens: number,
): number {
  if (!Number.isFinite(targetTokens) || targetTokens < 0) {
    throw new RangeError("targetTokens must be a non-negative finite number");
  }
  const groups = groupToolInteractions(messages);
  if (groups.length === 0) return 0;

  let tokens = 0;
  let start = messages.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    const groupTokens = estimateMessages(group.messages).totalTokens;
    if (start < messages.length && tokens + groupTokens > targetTokens) break;
    start = group.start;
    tokens += groupTokens;
  }
  return start;
}

export function hasOrphanedToolResult(messages: readonly Message[]): boolean {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls) calls.add(call.id);
    } else if (message.role === "tool" && !calls.has(message.toolCallId)) {
      return true;
    }
  }
  return false;
}
