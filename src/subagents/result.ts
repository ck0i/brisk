import type { JsonValue } from "../core/messages.ts";
import type { CompleteTaskInput, NormalizedTaskInput, TaskMode, TaskResult } from "./types.ts";
import { isJsonObject } from "./types.ts";

const taskModes = new Set<TaskMode>(["research", "patch"]);
const resultStatuses = new Set<TaskResult["status"]>(["completed", "blocked", "failed"]);

export function parseTaskInput(value: JsonValue): NormalizedTaskInput {
  const object = requireStrictObject(value, ["description", "mode", "model", "maxOutputTokens"]);
  const description = requireNonEmptyString(object.description, "description");
  const rawMode = object.mode;
  const mode = rawMode === undefined ? "research" : requireTaskMode(rawMode);
  const requestedModel = optionalNonEmptyString(object.model, "model");
  // Models often fill optional fields with an unqualified display name. Treat that as omitted.
  const model = requestedModel && isQualifiedModel(requestedModel) ? requestedModel : undefined;
  const maxOutputTokens = optionalPositiveInteger(object.maxOutputTokens, "maxOutputTokens");

  return {
    description,
    mode,
    ...(model === undefined ? {} : { model }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export function parseCompleteTaskInput(value: JsonValue): CompleteTaskInput {
  const object = requireStrictObject(value, [
    "status",
    "summary",
    "patch",
    "filesConsidered",
    "testsSuggested",
    "blockers",
  ]);
  const status = requireResultStatus(object.status);
  const summary = requireNonEmptyString(object.summary, "summary");
  const patch = optionalString(object.patch, "patch");
  const filesConsidered = optionalStringArray(object.filesConsidered, "filesConsidered");
  const testsSuggested = optionalStringArray(object.testsSuggested, "testsSuggested");
  const blockers = optionalStringArray(object.blockers, "blockers");

  return {
    status,
    summary,
    ...(patch === undefined ? {} : { patch }),
    ...(filesConsidered === undefined ? {} : { filesConsidered }),
    ...(testsSuggested === undefined ? {} : { testsSuggested }),
    ...(blockers === undefined ? {} : { blockers }),
  };
}

export function parseTaskResult(value: JsonValue): TaskResult {
  const object = requireStrictObject(value, [
    "status",
    "summary",
    "patch",
    "filesConsidered",
    "testsSuggested",
    "blockers",
    "childSessionId",
  ]);
  const partial = parseCompleteTaskInputWithoutStrictness(object);
  const childSessionId = requireNonEmptyString(object.childSessionId, "childSessionId");
  return { ...partial, childSessionId };
}

export function withChildSessionId(input: CompleteTaskInput, childSessionId: string): TaskResult {
  return { ...input, childSessionId };
}

export function serializeTaskResult(result: TaskResult): string {
  return JSON.stringify(result);
}

function parseCompleteTaskInputWithoutStrictness(object: {
  readonly [key: string]: JsonValue;
}): CompleteTaskInput {
  const status = requireResultStatus(object.status);
  const summary = requireNonEmptyString(object.summary, "summary");
  const patch = optionalString(object.patch, "patch");
  const filesConsidered = optionalStringArray(object.filesConsidered, "filesConsidered");
  const testsSuggested = optionalStringArray(object.testsSuggested, "testsSuggested");
  const blockers = optionalStringArray(object.blockers, "blockers");
  return {
    status,
    summary,
    ...(patch === undefined ? {} : { patch }),
    ...(filesConsidered === undefined ? {} : { filesConsidered }),
    ...(testsSuggested === undefined ? {} : { testsSuggested }),
    ...(blockers === undefined ? {} : { blockers }),
  };
}

function requireStrictObject(
  value: JsonValue,
  allowedKeys: readonly string[],
): { readonly [key: string]: JsonValue } {
  if (!isJsonObject(value)) throw new TypeError("arguments must be an object");
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${key} is not allowed`);
  }
  return value;
}

function requireTaskMode(value: JsonValue): TaskMode {
  if (typeof value !== "string" || !taskModes.has(value as TaskMode)) {
    throw new TypeError("mode must be research or patch");
  }
  return value as TaskMode;
}

function requireResultStatus(value: JsonValue | undefined): TaskResult["status"] {
  if (typeof value !== "string" || !resultStatuses.has(value as TaskResult["status"])) {
    throw new TypeError("status must be completed, blocked, or failed");
  }
  return value as TaskResult["status"];
}

function requireNonEmptyString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function isQualifiedModel(value: string): boolean {
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function optionalNonEmptyString(value: JsonValue | undefined, name: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, name);
}

function optionalString(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalPositiveInteger(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function optionalStringArray(
  value: JsonValue | undefined,
  name: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return Object.freeze([...value]);
}
