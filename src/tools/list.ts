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

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_DEPTH = 64;

export interface ListInput {
  readonly path?: string;
  readonly depth?: number;
  readonly hidden?: boolean;
  readonly respectIgnore?: boolean;
  readonly ignoreGenerated?: boolean;
  readonly limit?: number;
}

export interface ListEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface ListResult {
  readonly entries: readonly ListEntry[];
  readonly truncated: boolean;
}

export interface ListOptions {
  readonly signal?: AbortSignal;
}

export async function listFiles(
  workspace: string,
  input: ListInput = {},
  options: ListOptions = {},
): Promise<ListResult> {
  const depth = validateDepth(input.depth ?? 1);
  const limit = validateLimit(input.limit ?? DEFAULT_LIST_LIMIT);
  const location = await resolveWorkspacePath(workspace, input.path ?? ".");
  const ignoreRoot = location.insideWorkspace ? location.workspace : location.path;
  const ignoreRules = input.respectIgnore === false ? [] : await loadIgnoreRules(ignoreRoot);
  const entries = new Map<string, ListEntry>();

  for (let level = 1; level <= depth; level += 1) {
    throwIfAborted(options.signal);
    const glob = new Bun.Glob(`${"*/".repeat(level - 1)}*`);
    for await (const child of glob.scan({
      cwd: location.path,
      dot: input.hidden === true,
      absolute: false,
      followSymlinks: false,
      onlyFiles: false,
    })) {
      throwIfAborted(options.signal);
      const absolutePath = resolve(location.path, child);
      const matchPath = normalizeRelative(stableRelative(ignoreRoot, absolutePath));
      const displayPath = normalizeRelative(stableRelative(location.workspace, absolutePath));
      if (displayPath === ".") continue;
      if (input.ignoreGenerated !== false && isGeneratedPath(matchPath)) continue;
      const stat = await lstat(absolutePath);
      if (isIgnoredPath(matchPath, stat.isDirectory(), ignoreRules)) continue;
      entries.set(displayPath, { path: displayPath, type: entryType(stat) });
    }
  }

  const sorted = [...entries.values()].sort((left, right) => comparePaths(left.path, right.path));
  return { entries: sorted.slice(0, limit), truncated: sorted.length > limit };
}

export function createListTool(workspace: string): ToolDefinition<ListInput> {
  return {
    name: "list",
    description:
      "List directory entries. Relative paths use the workspace; absolute paths may target any directory. The default depth lists immediate children.",
    inputSchema: LIST_SCHEMA,
    readOnly: true,
    parallelSafe: true,
    parse: parseListInput,
    async execute(input, context) {
      const result = await listFiles(workspace, input, { signal: context.signal });
      const content = result.entries
        .map((entry) => `${entry.path}${entry.type === "directory" ? "/" : ""}`)
        .join("\n");
      const suffix = result.truncated ? `\n[results limited to ${result.entries.length}]` : "";
      return { content: `${content || "(directory is empty)"}${suffix}` };
    },
  };
}

const LIST_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    depth: { type: "integer", minimum: 1, maximum: MAX_LIST_DEPTH },
    hidden: { type: "boolean" },
    respectIgnore: { type: "boolean" },
    ignoreGenerated: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 10_000 },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function parseListInput(value: JsonValue): ListInput {
  if (!isJsonObject(value)) throw new Error("arguments must be an object");
  return {
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.depth === "number" ? { depth: value.depth } : {}),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(typeof value.respectIgnore === "boolean" ? { respectIgnore: value.respectIgnore } : {}),
    ...(typeof value.ignoreGenerated === "boolean"
      ? { ignoreGenerated: value.ignoreGenerated }
      : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  };
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDepth(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIST_DEPTH) {
    throw new RangeError(`List depth must be an integer from 1 through ${MAX_LIST_DEPTH}`);
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new RangeError("List limit must be an integer from 1 through 10000");
  }
  return value;
}

function entryType(stat: Awaited<ReturnType<typeof lstat>>): ListEntry["type"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
