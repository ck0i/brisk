import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import type { ToolContext, ToolResult } from "../tools/registry.ts";
import type {
  BriskExtensionActivator,
  ExtensionDisposable,
  ExtensionLifecycleEvent,
  KeybindingDefinition,
  LifecycleHook,
  SlashCommandDefinition,
  UiSlotContribution,
} from "./types.ts";

export type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ValidatedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly?: boolean;
  readonly parallelSafe?: boolean;
  readonly timeoutMs?: number;
  readonly parse?: (value: JsonValue) => unknown;
  readonly execute: (value: unknown, context: ToolContext) => unknown;
}

const definitionKeys = new Set([
  "name",
  "description",
  "inputSchema",
  "readOnly",
  "parallelSafe",
  "timeoutMs",
  "parse",
  "execute",
]);
const commandKeys = new Set(["name", "description", "execute"]);
const keybindingKeys = new Set(["key", "description", "execute"]);
const uiKeys = new Set(["id", "slot", "text", "priority"]);
const schemaKeys = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const uiSlots = new Set(["header", "sidebar", "status", "composer"]);
const lifecycleEvents = new Set([
  "extensions-loaded",
  "session-start",
  "session-end",
  "turn-start",
  "turn-end",
  "shutdown",
]);

export function validateToolDefinition(value: unknown): ValidationResult<ValidatedToolDefinition> {
  if (!isRecord(value)) return invalid("tool definition must be an object");
  const unknownKey = findUnknownKey(value, definitionKeys);
  if (unknownKey) return invalid(`tool definition has unknown field ${unknownKey}`);
  if (!isIdentifier(value.name, 64)) return invalid("tool name is invalid");
  if (!isDescription(value.description)) return invalid("tool description is invalid");
  const schemaError = validateJsonSchema(value.inputSchema, new WeakSet(), "$inputSchema");
  if (schemaError) return invalid(schemaError);
  if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") {
    return invalid("tool readOnly must be a boolean");
  }
  if (value.parallelSafe !== undefined && typeof value.parallelSafe !== "boolean") {
    return invalid("tool parallelSafe must be a boolean");
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isFinite(value.timeoutMs) ||
      value.timeoutMs <= 0)
  ) {
    return invalid("tool timeoutMs must be a positive finite number");
  }
  if (value.parse !== undefined && typeof value.parse !== "function") {
    return invalid("tool parse must be a function");
  }
  if (typeof value.execute !== "function") return invalid("tool execute must be a function");

  let inputSchema: JsonSchema;
  try {
    inputSchema = structuredClone(value.inputSchema) as JsonSchema;
  } catch {
    return invalid("tool inputSchema must be cloneable");
  }
  return {
    ok: true,
    value: {
      name: value.name,
      description: value.description,
      inputSchema,
      ...(value.readOnly === undefined ? {} : { readOnly: value.readOnly }),
      ...(value.parallelSafe === undefined ? {} : { parallelSafe: value.parallelSafe }),
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
      ...(value.parse === undefined ? {} : { parse: value.parse as (input: JsonValue) => unknown }),
      execute: value.execute as (input: unknown, context: ToolContext) => unknown,
    },
  };
}

export function validateToolResult(value: unknown): ValidationResult<ToolResult> {
  if (!isRecord(value)) return invalid("tool result must be an object");
  const unknownKey = findUnknownKey(value, new Set(["content", "isError"]));
  if (unknownKey) return invalid(`tool result has unknown field ${unknownKey}`);
  if (typeof value.content !== "string") return invalid("tool result content must be a string");
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    return invalid("tool result isError must be a boolean");
  }
  return {
    ok: true,
    value: {
      content: value.content,
      ...(value.isError === undefined ? {} : { isError: value.isError }),
    },
  };
}

export function validateSlashCommand(value: unknown): ValidationResult<SlashCommandDefinition> {
  if (!isRecord(value)) return invalid("slash command must be an object");
  const unknownKey = findUnknownKey(value, commandKeys);
  if (unknownKey) return invalid(`slash command has unknown field ${unknownKey}`);
  if (!isCommandName(value.name)) return invalid("slash command name is invalid");
  if (!isDescription(value.description)) return invalid("slash command description is invalid");
  if (typeof value.execute !== "function")
    return invalid("slash command execute must be a function");
  return {
    ok: true,
    value: {
      name: value.name,
      description: value.description,
      execute: value.execute as SlashCommandDefinition["execute"],
    },
  };
}

export function validateKeybinding(value: unknown): ValidationResult<KeybindingDefinition> {
  if (!isRecord(value)) return invalid("keybinding must be an object");
  const unknownKey = findUnknownKey(value, keybindingKeys);
  if (unknownKey) return invalid(`keybinding has unknown field ${unknownKey}`);
  if (
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    value.key.length > 64 ||
    [...value.key].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    return invalid("keybinding key is invalid");
  }
  if (!isDescription(value.description)) return invalid("keybinding description is invalid");
  if (typeof value.execute !== "function") return invalid("keybinding execute must be a function");
  return {
    ok: true,
    value: {
      key: value.key,
      description: value.description,
      execute: value.execute as KeybindingDefinition["execute"],
    },
  };
}

export function validateUiContribution(value: unknown): ValidationResult<UiSlotContribution> {
  if (!isRecord(value)) return invalid("UI contribution must be an object");
  const unknownKey = findUnknownKey(value, uiKeys);
  if (unknownKey) return invalid(`UI contribution has unknown field ${unknownKey}`);
  if (!isIdentifier(value.id, 64)) return invalid("UI contribution id is invalid");
  if (!isUiSlot(value.slot)) return invalid("UI contribution slot is invalid");
  if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 4096) {
    return invalid("UI contribution text is invalid");
  }
  if (
    value.priority !== undefined &&
    (typeof value.priority !== "number" ||
      !Number.isInteger(value.priority) ||
      value.priority < -1000 ||
      value.priority > 1000)
  ) {
    return invalid("UI contribution priority must be an integer from -1000 to 1000");
  }
  return {
    ok: true,
    value: {
      id: value.id,
      slot: value.slot,
      text: value.text,
      ...(value.priority === undefined ? {} : { priority: value.priority }),
    },
  };
}

export function validateLifecycleEvent(value: unknown): value is ExtensionLifecycleEvent {
  return typeof value === "string" && lifecycleEvents.has(value);
}

export function validateLifecycleHook(value: unknown): value is LifecycleHook {
  return typeof value === "function";
}

export function validateActivator(moduleValue: unknown): ValidationResult<BriskExtensionActivator> {
  if (!isRecord(moduleValue)) return invalid("extension module must export a default activator");
  const exported: unknown = moduleValue.default;
  if (typeof exported === "function") {
    return { ok: true, value: exported as BriskExtensionActivator };
  }
  if (!isRecord(exported)) return invalid("default export must be a function or extension object");
  const unknownKey = findUnknownKey(exported, new Set(["activate"]));
  if (unknownKey) return invalid(`extension object has unknown field ${unknownKey}`);
  if (typeof exported.activate !== "function") {
    return invalid("extension object activate must be a function");
  }
  return { ok: true, value: exported.activate as BriskExtensionActivator };
}

export function validateActivationResult(
  value: unknown,
): ValidationResult<(() => void | Promise<void>) | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === "function") {
    return { ok: true, value: value as () => void | Promise<void> };
  }
  if (!isRecord(value)) {
    return invalid("extension activator returned an invalid disposable");
  }
  const unknownKey = findUnknownKey(value, new Set(["dispose"]));
  if (unknownKey) return invalid(`extension disposable has unknown field ${unknownKey}`);
  if (typeof value.dispose !== "function") {
    return invalid("extension disposable dispose must be a function");
  }
  const disposable = value as unknown as ExtensionDisposable;
  return { ok: true, value: () => disposable.dispose() };
}

export function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function validateJsonSchema(
  value: unknown,
  stack: WeakSet<object>,
  path: string,
): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (stack.has(value)) return `${path} must not be cyclic`;
  stack.add(value);
  try {
    const unknownKey = findUnknownKey(value, schemaKeys);
    if (unknownKey) return `${path} has unknown field ${unknownKey}`;
    if (
      value.type !== undefined &&
      (typeof value.type !== "string" || !schemaTypes.has(value.type))
    ) {
      return `${path}.type is invalid`;
    }
    if (value.description !== undefined && typeof value.description !== "string") {
      return `${path}.description must be a string`;
    }
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) return `${path}.properties must be an object`;
      for (const [name, schema] of Object.entries(value.properties)) {
        const error = validateJsonSchema(schema, stack, `${path}.properties.${name}`);
        if (error) return error;
      }
    }
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string"))
    ) {
      return `${path}.required must be an array of strings`;
    }
    if (value.items !== undefined) {
      const error = validateJsonSchema(value.items, stack, `${path}.items`);
      if (error) return error;
    }
    if (
      value.enum !== undefined &&
      (!Array.isArray(value.enum) || !value.enum.every(isJsonValue))
    ) {
      return `${path}.enum must contain only JSON values`;
    }
    if ("const" in value && !isJsonValue(value.const)) return `${path}.const must be a JSON value`;
    if (value.additionalProperties !== undefined) {
      if (typeof value.additionalProperties !== "boolean") {
        const error = validateJsonSchema(
          value.additionalProperties,
          stack,
          `${path}.additionalProperties`,
        );
        if (error) return error;
      }
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const child = value[keyword];
      if (child === undefined) continue;
      if (!Array.isArray(child) || child.length === 0) {
        return `${path}.${keyword} must be a non-empty schema array`;
      }
      for (const [index, schema] of child.entries()) {
        const error = validateJsonSchema(schema, stack, `${path}.${keyword}[${index}]`);
        if (error) return error;
      }
    }
    for (const keyword of ["minimum", "maximum"] as const) {
      const child = value[keyword];
      if (child !== undefined && (typeof child !== "number" || !Number.isFinite(child))) {
        return `${path}.${keyword} must be finite`;
      }
    }
    for (const keyword of ["minLength", "maxLength"] as const) {
      const child = value[keyword];
      if (
        child !== undefined &&
        (typeof child !== "number" || !Number.isInteger(child) || child < 0)
      ) {
        return `${path}.${keyword} must be a non-negative integer`;
      }
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string") return `${path}.pattern must be a string`;
      try {
        new RegExp(value.pattern);
      } catch {
        return `${path}.pattern must be a valid regular expression`;
      }
    }
    return undefined;
  } finally {
    stack.delete(value);
  }
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
  );
}

function isCommandName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}

function isDescription(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1000;
}

function isUiSlot(value: unknown): value is UiSlotContribution["slot"] {
  return typeof value === "string" && uiSlots.has(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUnknownKey(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
