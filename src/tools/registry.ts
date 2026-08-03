import { isAbortError } from "../core/events.ts";
import type { JsonValue, ToolCall, ToolResultMessage } from "../core/messages.ts";
import type { JsonSchema, ProviderToolSchema } from "../providers/types.ts";

export type ToolOutputStream = "stdout" | "stderr" | "progress";

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
  emitOutput(stream: ToolOutputStream, delta: string): void;
}

export interface ToolExecutionObserver {
  onStart?(call: ToolCall): void;
  onOutput?(call: ToolCall, stream: ToolOutputStream, delta: string): void;
  onEnd?(call: ToolCall, result: ToolResultMessage): void;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolDefinition<TArguments = JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly?: boolean;
  readonly parallelSafe?: boolean;
  readonly timeoutMs?: number;
  readonly parse?: (value: JsonValue) => TArguments;
  execute(arguments_: TArguments, context: ToolContext): ToolResult | Promise<ToolResult>;
}

interface StoredTool {
  readonly schema: ProviderToolSchema;
  readonly concurrent: boolean;
  readonly timeoutMs: number;
  readonly invoke: (value: JsonValue, context: ToolContext) => Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, StoredTool>();

  constructor(private readonly defaultTimeoutMs = 30_000) {
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new RangeError("Tool timeout must be a positive finite number");
    }
  }

  register<TArguments = JsonValue>(definition: ToolDefinition<TArguments>): this {
    if (definition.name.length === 0) throw new Error("Tool name cannot be empty");
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }

    const timeoutMs = definition.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`Invalid timeout for tool ${definition.name}`);
    }

    const invoke = async (value: JsonValue, context: ToolContext): Promise<ToolResult> => {
      let arguments_: TArguments;
      try {
        arguments_ = definition.parse ? definition.parse(value) : (value as TArguments);
      } catch (error) {
        throw new ToolArgumentError(errorMessage(error), { cause: error });
      }
      return await definition.execute(arguments_, context);
    };

    this.tools.set(definition.name, {
      schema: {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      concurrent: definition.readOnly === true && definition.parallelSafe === true,
      timeoutMs,
      invoke,
    });
    return this;
  }

  get schemas(): readonly ProviderToolSchema[] {
    return [...this.tools.values()].map((tool) => tool.schema);
  }

  async execute(
    calls: readonly ToolCall[],
    signal: AbortSignal,
    observer: ToolExecutionObserver = {},
  ): Promise<ToolResultMessage[]> {
    throwIfAborted(signal);
    const results = Array.from<ToolResultMessage | undefined>({ length: calls.length });

    let index = 0;
    while (index < calls.length) {
      throwIfAborted(signal);
      const call = calls[index];
      if (!call) break;
      const tool = this.tools.get(call.name);

      if (tool?.concurrent === true) {
        const start = index;
        const pending: Promise<void>[] = [];
        while (index < calls.length) {
          const parallelCall = calls[index];
          if (!parallelCall) break;
          const parallelTool = this.tools.get(parallelCall.name);
          if (parallelTool?.concurrent !== true) break;
          const resultIndex = index;
          pending.push(
            this.executeOne(parallelCall, parallelTool, signal, observer).then((result) => {
              results[resultIndex] = result;
            }),
          );
          index += 1;
        }
        if (index === start) index += 1;
        await Promise.all(pending);
      } else {
        results[index] = await this.executeOne(call, tool, signal, observer);
        index += 1;
      }
    }

    throwIfAborted(signal);
    return results.map((result, resultIndex) => {
      if (result) return result;
      const call = calls[resultIndex];
      if (!call) throw new Error("Tool result ordering invariant failed");
      return errorResult(call, "Tool did not produce a result");
    });
  }

  private async executeOne(
    call: ToolCall,
    tool: StoredTool | undefined,
    signal: AbortSignal,
    observer: ToolExecutionObserver,
  ): Promise<ToolResultMessage> {
    throwIfAborted(signal);
    notifyObserver(() => observer.onStart?.(call));
    const finish = (result: ToolResultMessage): ToolResultMessage => {
      notifyObserver(() => observer.onEnd?.(call, result));
      return result;
    };
    if (!tool) return finish(errorResult(call, `Unknown tool: ${call.name}`));

    let parsed: JsonValue;
    try {
      const value: unknown = JSON.parse(call.arguments);
      if (!isJsonValue(value)) throw new Error("arguments contain a non-JSON value");
      const validationError = validateSchema(value, tool.schema.inputSchema, "$arguments");
      if (validationError) throw new Error(validationError);
      parsed = value;
    } catch (error) {
      return finish(
        errorResult(call, `Invalid arguments for ${call.name}: ${errorMessage(error)}`),
      );
    }

    const controller = new AbortController();
    const abortTool = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abortTool, { once: true });

    try {
      const result = await invokeWithDeadline(
        tool.invoke(parsed, {
          signal: controller.signal,
          callId: call.id,
          toolName: call.name,
          emitOutput(stream, delta) {
            if (!controller.signal.aborted && delta.length > 0) {
              notifyObserver(() => observer.onOutput?.(call, stream, delta));
            }
          },
        }),
        tool.timeoutMs,
        controller,
        signal,
      );
      throwIfAborted(signal);
      return finish({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        if (signal.aborted) throw abortReason(signal);
      }
      if (error instanceof ToolTimeoutError) {
        return finish(errorResult(call, `Tool ${call.name} timed out after ${tool.timeoutMs}ms`));
      }
      if (error instanceof ToolArgumentError) {
        return finish(errorResult(call, `Invalid arguments for ${call.name}: ${error.message}`));
      }
      return finish(errorResult(call, `Tool ${call.name} failed: ${errorMessage(error)}`));
    } finally {
      signal.removeEventListener("abort", abortTool);
    }
  }
}

class ToolTimeoutError extends Error {
  constructor() {
    super("Tool timed out");
    this.name = "ToolTimeoutError";
  }
}

class ToolArgumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolArgumentError";
  }
}

function invokeWithDeadline<T>(
  execution: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  parentSignal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(abortReason(parentSignal)));
    const timer = setTimeout(() => {
      finish(() => {
        controller.abort(new ToolTimeoutError());
        reject(new ToolTimeoutError());
      });
    }, timeoutMs);

    parentSignal.addEventListener("abort", onAbort, { once: true });
    execution.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (parentSignal.aborted) onAbort();
  });
}

function validateSchema(value: JsonValue, schema: JsonSchema, path: string): string | undefined {
  if (schema.type && !matchesType(value, schema.type)) {
    return `${path} must be ${schema.type}`;
  }
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    return `${path} must be one of the allowed values`;
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    return `${path} must equal the required value`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} must contain at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} must contain at most ${schema.maxLength} characters`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${path} does not match the required pattern`;
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} must be finite`;
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} must be at least ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path} must be at most ${schema.maximum}`;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) continue;
      const error = validateSchema(item, schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (isJsonObject(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) return `${path}.${required} is required`;
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        const error = validateSchema(child, propertySchema, `${path}.${key}`);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      } else if (typeof schema.additionalProperties === "object") {
        const error = validateSchema(child, schema.additionalProperties, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  for (const candidate of schema.allOf ?? []) {
    const error = validateSchema(value, candidate, path);
    if (error) return error;
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => !validateSchema(value, candidate, path))) {
    return `${path} does not match any allowed schema`;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (candidate) => !validateSchema(value, candidate, path),
    ).length;
    if (matches !== 1) return `${path} must match exactly one allowed schema`;
  }
  return undefined;
}

function matchesType(value: JsonValue, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorResult(call: ToolCall, content: string): ToolResultMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content,
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyObserver(callback: () => void): void {
  try {
    callback();
  } catch {
    // Observability must never change tool execution semantics.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
