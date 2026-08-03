import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import type { ToolDefinition } from "./registry.ts";
import {
  isGeneratedPath,
  isIgnoredPath,
  loadIgnoreRules,
  normalizeRelative,
  resolveWorkspacePath,
  stableRelative,
  throwIfAborted,
} from "./filesystem.ts";

const DEFAULT_FIND_LIMIT = 200;

export interface FindInput {
  readonly patterns: string | readonly string[];
  readonly path?: string;
  readonly hidden?: boolean;
  readonly respectIgnore?: boolean;
  readonly ignoreGenerated?: boolean;
  readonly includeDirectories?: boolean;
  readonly limit?: number;
}

export interface FindResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

export interface FindOptions {
  readonly signal?: AbortSignal;
}

export async function findFiles(
  workspace: string,
  input: FindInput,
  options: FindOptions = {},
): Promise<FindResult> {
  const patterns = normalizePatterns(input.patterns);
  const limit = validateLimit(input.limit ?? DEFAULT_FIND_LIMIT);
  const location = await resolveWorkspacePath(workspace, input.path ?? ".");
  const ignoreRules =
    input.respectIgnore === false ? [] : await loadIgnoreRules(location.workspace);
  const found = new Set<string>();

  for (const pattern of patterns) {
    throwIfAborted(options.signal);
    const glob = new Bun.Glob(pattern);
    for await (const entry of glob.scan({
      cwd: location.path,
      dot: input.hidden === true,
      absolute: false,
      followSymlinks: false,
      onlyFiles: input.includeDirectories !== true,
    })) {
      throwIfAborted(options.signal);
      const path = stableRelative(location.workspace, resolve(location.path, entry));
      if (path === ".") continue;
      if (input.ignoreGenerated !== false && isGeneratedPath(path)) continue;
      const stat = await lstat(resolve(location.workspace, path));
      if (isIgnoredPath(path, stat.isDirectory(), ignoreRules)) continue;
      found.add(normalizeRelative(path));
    }
  }

  const sorted = [...found].sort(comparePaths);
  return { paths: sorted.slice(0, limit), truncated: sorted.length > limit };
}

export function createFindTool(workspace: string): ToolDefinition<FindInput> {
  return {
    name: "find",
    description: "Find workspace files matching one or more glob patterns.",
    inputSchema: FIND_SCHEMA,
    readOnly: true,
    parallelSafe: true,
    parse: parseFindInput,
    async execute(input, context) {
      const result = await findFiles(workspace, input, { signal: context.signal });
      const suffix = result.truncated ? `\n[results limited to ${result.paths.length}]` : "";
      return { content: `${result.paths.join("\n") || "(no files found)"}${suffix}` };
    },
  };
}

const FIND_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "array", items: { type: "string", minLength: 1 } },
      ],
    },
    path: { type: "string" },
    hidden: { type: "boolean" },
    respectIgnore: { type: "boolean" },
    ignoreGenerated: { type: "boolean" },
    includeDirectories: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 10_000 },
  },
  required: ["patterns"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseFindInput(value: JsonValue): FindInput {
  const object = requireObject(value);
  const patternValue = object.patterns;
  let patterns: string | readonly string[];
  if (typeof patternValue === "string") {
    patterns = patternValue;
  } else if (
    Array.isArray(patternValue) &&
    patternValue.every((item) => typeof item === "string")
  ) {
    patterns = patternValue;
  } else {
    throw new Error("patterns must be a string or an array of strings");
  }
  return {
    patterns,
    ...optionalString(object, "path"),
    ...optionalBoolean(object, "hidden"),
    ...optionalBoolean(object, "respectIgnore"),
    ...optionalBoolean(object, "ignoreGenerated"),
    ...optionalBoolean(object, "includeDirectories"),
    ...optionalNumber(object, "limit"),
  };
}

function normalizePatterns(value: string | readonly string[]): readonly string[] {
  const patterns = typeof value === "string" ? [value] : [...value];
  if (patterns.length === 0) throw new Error("At least one find pattern is required");
  for (const pattern of patterns) {
    if (pattern.length === 0) throw new Error("Find patterns cannot be empty");
    const normalized = pattern.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Find pattern escapes workspace: ${pattern}`);
    }
  }
  return patterns;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new RangeError("Find limit must be an integer from 1 through 10000");
  }
  return value;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (!isJsonObject(value)) throw new Error("arguments must be an object");
  return value;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  object: { readonly [key: string]: JsonValue },
  key: string,
): { readonly [key: string]: string } | Record<string, never> {
  const value = object[key];
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return { [key]: value };
}

function optionalBoolean(
  object: { readonly [key: string]: JsonValue },
  key: string,
): { readonly [key: string]: boolean } | Record<string, never> {
  const value = object[key];
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return { [key]: value };
}

function optionalNumber(
  object: { readonly [key: string]: JsonValue },
  key: string,
): { readonly [key: string]: number } | Record<string, never> {
  const value = object[key];
  if (value === undefined) return {};
  if (typeof value !== "number") throw new Error(`${key} must be a number`);
  return { [key]: value };
}
