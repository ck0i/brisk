import {
  NormalizedProviderError,
  type NormalizedProviderErrorKind,
  type NormalizedProviderErrorOptions,
  type ProviderEvent,
} from "../core/events.ts";
import type { JsonValue, Usage } from "../core/messages.ts";
import type { Provider, ProviderRequest } from "./types.ts";

export type FakeChunk = string | { readonly value: string; readonly delayMs?: number };
export type FakeChunks = string | readonly FakeChunk[];

export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  /** a raw JSON string, or a value which will be JSON encoded */
  readonly arguments?: string | JsonValue;
  /** explicit raw chunks take precedence over arguments */
  readonly argumentChunks?: readonly FakeChunk[];
  readonly malformed?: boolean;
  readonly chunkDelayMs?: number;
}

export interface FakeError {
  readonly kind: NormalizedProviderErrorKind;
  readonly message: string;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly retryAfter?: number;
}

export interface FakeProviderTurn {
  readonly id?: string;
  readonly delayMs?: number;
  readonly chunkDelayMs?: number;
  readonly thinking?: FakeChunks;
  readonly text?: FakeChunks;
  readonly toolCalls?: readonly FakeToolCall[];
  readonly usage?: Usage;
  readonly error?: NormalizedProviderError | FakeError;
  readonly stopReason?: "stop" | "tool_call" | "length" | "unknown";
  readonly omitResponseEnd?: boolean;
}

/** a deterministic provider which consumes one scripted turn for each stream request */
export class FakeProvider implements Provider {
  readonly requests: ProviderRequest[] = [];
  private nextTurn = 0;

  constructor(private readonly turns: readonly FakeProviderTurn[]) {}

  get requestCount(): number {
    return this.nextTurn;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const turn = this.turns[this.nextTurn];
    this.nextTurn += 1;
    this.requests.push({ ...request, messages: [...request.messages], tools: [...request.tools] });

    if (!turn) {
      throw new NormalizedProviderError("Fake provider script exhausted", {
        kind: "invalid_response",
      });
    }

    await abortableDelay(turn.delayMs ?? 0, request.signal);
    yield optionalId({ type: "response_start" }, turn.id);

    yield* emitChunks("thinking_delta", turn.thinking, turn.chunkDelayMs, request.signal);
    yield* emitChunks("text_delta", turn.text, turn.chunkDelayMs, request.signal);

    for (let index = 0; index < (turn.toolCalls?.length ?? 0); index += 1) {
      const call = turn.toolCalls?.[index];
      if (!call) continue;
      throwIfAborted(request.signal);
      yield { type: "tool_call_start", index, id: call.id, name: call.name };

      const chunks = toolArgumentChunks(call);
      for (const chunk of chunks) {
        await abortableDelay(
          chunkDelay(chunk, call.chunkDelayMs ?? turn.chunkDelayMs),
          request.signal,
        );
        yield { type: "tool_call_delta", index, delta: chunkValue(chunk) };
      }

      throwIfAborted(request.signal);
      yield { type: "tool_call_end", index };
    }

    if (turn.usage) {
      throwIfAborted(request.signal);
      yield { type: "usage", usage: turn.usage };
    }

    if (turn.error) {
      throwIfAborted(request.signal);
      yield { type: "error", error: toNormalizedError(turn.error) };
      return;
    }

    if (!turn.omitResponseEnd) {
      throwIfAborted(request.signal);
      const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? "tool_call" : "stop");
      yield { type: "response_end", stopReason };
    }
  }
}

export function fakeProviderError(
  kind: NormalizedProviderErrorKind,
  message: string,
  options: Omit<NormalizedProviderErrorOptions, "kind"> = {},
): NormalizedProviderError {
  return new NormalizedProviderError(message, { ...options, kind });
}

async function* emitChunks(
  type: "text_delta" | "thinking_delta",
  input: FakeChunks | undefined,
  defaultDelayMs: number | undefined,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const chunks = typeof input === "string" ? [input] : (input ?? []);
  for (const chunk of chunks) {
    await abortableDelay(chunkDelay(chunk, defaultDelayMs), signal);
    yield { type, delta: chunkValue(chunk) };
  }
}

function toolArgumentChunks(call: FakeToolCall): readonly FakeChunk[] {
  if (call.argumentChunks) return call.argumentChunks;

  let encoded: string;
  if (typeof call.arguments === "string") encoded = call.arguments;
  else encoded = JSON.stringify(call.arguments ?? {});

  if (call.malformed) encoded = encoded.length > 0 ? encoded.slice(0, -1) : "{";
  return [encoded];
}

function chunkValue(chunk: FakeChunk): string {
  return typeof chunk === "string" ? chunk : chunk.value;
}

function chunkDelay(chunk: FakeChunk, fallback = 0): number {
  return typeof chunk === "string" ? fallback : (chunk.delayMs ?? fallback);
}

function optionalId(
  event: { readonly type: "response_start" },
  id: string | undefined,
): ProviderEvent {
  return id === undefined ? event : { ...event, id };
}

function toNormalizedError(error: NormalizedProviderError | FakeError): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;
  const options: NormalizedProviderErrorOptions = {
    kind: error.kind,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
  };
  return new NormalizedProviderError(error.message, options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
