import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import type { ToolDefinition } from "./registry.ts";
import {
  COMMON_GENERATED_DIRECTORIES,
  isGeneratedPath,
  isHiddenPath,
  isIgnoredPath,
  loadIgnoreRules,
  matchesGlobs,
  normalizeRelative,
  resolveWorkspacePath,
  stableRelative,
  throwIfAborted,
} from "./filesystem.ts";
import {
  terminateProcessTree,
  toolProcessRegistry,
  type ProcessRegistry,
} from "./process-registry.ts";

const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 10_000;
const MAX_ERROR_CHARS = 32_000;

export interface SearchInput {
  readonly pattern: string;
  readonly path?: string;
  readonly regex?: boolean;
  readonly globs?: readonly string[];
  readonly hidden?: boolean;
  readonly respectIgnore?: boolean;
  readonly ignoreGenerated?: boolean;
  readonly caseSensitive?: boolean;
  readonly context?: number;
  readonly limit?: number;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly before: readonly SearchContextLine[];
  readonly after: readonly SearchContextLine[];
}

export interface SearchContextLine {
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly backend: "rg" | "fallback";
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly fallbackReason?: string;
}

export interface SearchStreamEvent {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface SearchOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: SearchStreamEvent) => void | Promise<void>;
  readonly rgPath?: string;
  readonly forceFallback?: boolean;
  readonly processRegistry?: ProcessRegistry;
}

interface ParsedMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface ParsedContext {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface RgRecordData {
  readonly path?: { readonly text?: unknown };
  readonly lines?: { readonly text?: unknown };
  readonly line_number?: unknown;
  readonly submatches?: readonly { readonly start?: unknown }[];
}

export async function searchWorkspace(
  workspace: string,
  input: SearchInput,
  options: SearchOptions = {},
): Promise<SearchResult> {
  validateSearchInput(input);
  const location = await resolveWorkspacePath(workspace, input.path ?? ".");
  throwIfAborted(options.signal);
  const rgPath = options.forceFallback === true ? undefined : findRipgrep(options.rgPath ?? "rg");
  if (rgPath)
    return await searchWithRipgrep(location.workspace, location.relative, rgPath, input, options);
  return await searchWithFallback(location.workspace, location.path, input, options);
}

export function buildRipgrepArguments(input: SearchInput, target = "."): readonly string[] {
  validateSearchInput(input);
  const arguments_: string[] = ["--json", "--line-number", "--color=never", "--sort=path"];
  if (input.regex !== true) arguments_.push("--fixed-strings");
  if (input.caseSensitive === false) arguments_.push("--ignore-case");
  if (input.hidden === true) arguments_.push("--hidden");
  if (input.respectIgnore === false) arguments_.push("--no-ignore");
  if ((input.context ?? 0) > 0) arguments_.push("--context", String(input.context));
  for (const glob of input.globs ?? []) arguments_.push("--glob", glob);
  if (input.ignoreGenerated !== false) {
    for (const directory of [...COMMON_GENERATED_DIRECTORIES].sort()) {
      arguments_.push("--glob", `!${directory}/**`, "--glob", `!**/${directory}/**`);
    }
  }
  arguments_.push("--regexp", input.pattern, "--", target);
  return arguments_;
}

export function createSearchTool(
  workspace: string,
  options: Omit<SearchOptions, "signal"> = {},
): ToolDefinition<SearchInput> {
  return {
    name: "search",
    description: "Search workspace text with ripgrep and a Bun filesystem fallback.",
    inputSchema: SEARCH_SCHEMA,
    readOnly: true,
    parallelSafe: true,
    parse: parseSearchInput,
    async execute(input, context) {
      const result = await searchWorkspace(workspace, input, {
        ...options,
        signal: context.signal,
      });
      return { content: formatSearchResult(result) };
    },
  };
}

export function formatSearchResult(result: SearchResult): string {
  const heading =
    result.backend === "fallback"
      ? `[fallback search: ${result.fallbackReason ?? "ripgrep unavailable"}]\n`
      : "";
  const lines: string[] = [];
  for (const match of result.matches) {
    for (const context of match.before) lines.push(`${match.path}-${context.line}-${context.text}`);
    lines.push(`${match.path}:${match.line}:${match.column}:${match.text}`);
    for (const context of match.after) lines.push(`${match.path}-${context.line}-${context.text}`);
  }
  if (lines.length === 0) lines.push("(no matches found)");
  if (result.truncated) lines.push(`[results limited to ${result.matches.length} matches]`);
  return heading + lines.join("\n");
}

async function searchWithRipgrep(
  workspace: string,
  target: string,
  rgPath: string,
  input: SearchInput,
  options: SearchOptions,
): Promise<SearchResult> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const contextSize = input.context ?? 0;
  const arguments_ = [...buildRipgrepArguments(input, target)];
  if (input.respectIgnore !== false) {
    for (const filename of [".gitignore", ".ignore", ".rgignore"]) {
      if (existsSync(resolve(workspace, filename))) arguments_.unshift("--ignore-file", filename);
    }
  }
  const subprocess = Bun.spawn([rgPath, ...arguments_], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const registry = options.processRegistry ?? toolProcessRegistry;
  const unregister = registry.register(subprocess);
  let limited = false;
  let requestedStop = false;
  let termination: Promise<void> | undefined;
  const parsedMatches: ParsedMatch[] = [];
  const contexts: ParsedContext[] = [];
  const stderr = new BoundedText(MAX_ERROR_CHARS);
  const stop = (): Promise<void> => {
    requestedStop = true;
    termination ??= terminateProcessTree(subprocess);
    return termination;
  };
  const onAbort = (): void => {
    void stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const stdoutTask = consumeTextStream(subprocess.stdout, async (chunk) => {
      throwIfAborted(options.signal);
      await options.onOutput?.({ stream: "stdout", data: chunk });
      parser.push(chunk, (record) => {
        if (record.kind === "match") {
          if (parsedMatches.length >= limit) return false;
          parsedMatches.push(record.value);
          if (parsedMatches.length === limit) {
            limited = true;
            void stop();
            return false;
          }
        } else {
          contexts.push(record.value);
        }
        return true;
      });
    });
    const stderrTask = consumeTextStream(subprocess.stderr, async (chunk) => {
      stderr.write(chunk);
      await options.onOutput?.({ stream: "stderr", data: chunk });
    });
    const parser = new RipgrepParser(workspace);
    const [exitCode] = await Promise.all([subprocess.exited, stdoutTask, stderrTask]);
    parser.finish((record) => {
      if (record.kind === "context") contexts.push(record.value);
      else if (parsedMatches.length < limit) parsedMatches.push(record.value);
      return parsedMatches.length < limit;
    });
    if (termination) await termination;
    throwIfAborted(options.signal);
    if (!requestedStop && exitCode !== 0 && exitCode !== 1) {
      throw new Error(
        `ripgrep failed with exit code ${exitCode}: ${stderr.value() || "no error output"}`,
      );
    }
    return {
      backend: "rg",
      matches: attachContext(parsedMatches, contexts, contextSize),
      truncated: limited,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unregister();
  }
}

class RipgrepParser {
  private pending = "";

  constructor(private readonly workspace: string) {}

  push(chunk: string, consume: (record: ParsedRecord) => boolean): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const record = this.parseLine(line);
      if (record && !consume(record)) {
        this.pending = "";
        return;
      }
      newline = this.pending.indexOf("\n");
    }
  }

  finish(consume: (record: ParsedRecord) => boolean): void {
    if (this.pending.length === 0) return;
    const record = this.parseLine(this.pending);
    this.pending = "";
    if (record) consume(record);
  }

  private parseLine(line: string): ParsedRecord | undefined {
    if (line.length === 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error("ripgrep emitted invalid JSON", { cause: error });
    }
    if (!isRecord(value) || (value.type !== "match" && value.type !== "context")) return undefined;
    const data: RgRecordData = isRecord(value.data) ? value.data : {};
    const pathValue = data.path?.text;
    const textValue = data.lines?.text;
    const lineNumber = data.line_number;
    if (
      typeof pathValue !== "string" ||
      typeof textValue !== "string" ||
      typeof lineNumber !== "number"
    ) {
      throw new Error("ripgrep emitted an unsupported match record");
    }
    const absolutePath = resolve(this.workspace, pathValue);
    const path = normalizeRelative(stableRelative(this.workspace, absolutePath));
    const text = textValue.replace(/\r?\n$/, "");
    if (value.type === "context") {
      return { kind: "context", value: { path, line: lineNumber, text } };
    }
    const byteColumn = data.submatches?.[0]?.start;
    const column =
      typeof byteColumn === "number" ? utf8ByteOffsetToColumn(textValue, byteColumn) : 1;
    return { kind: "match", value: { path, line: lineNumber, column, text } };
  }
}

type ParsedRecord =
  | { readonly kind: "match"; readonly value: ParsedMatch }
  | { readonly kind: "context"; readonly value: ParsedContext };

async function searchWithFallback(
  workspace: string,
  searchRoot: string,
  input: SearchInput,
  options: SearchOptions,
): Promise<SearchResult> {
  const fallbackReason =
    "ripgrep unavailable; using Bun filesystem fallback (root ignore files and JavaScript regex semantics)";
  await options.onOutput?.({ stream: "stderr", data: `${fallbackReason}\n` });
  const ignoreRules = input.respectIgnore === false ? [] : await loadIgnoreRules(workspace);
  const files: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const entry of glob.scan({
    cwd: searchRoot,
    dot: input.hidden === true,
    absolute: false,
    followSymlinks: false,
    onlyFiles: true,
  })) {
    throwIfAborted(options.signal);
    const path = normalizeRelative(stableRelative(workspace, resolve(searchRoot, entry)));
    if (input.hidden !== true && isHiddenPath(path)) continue;
    if (input.ignoreGenerated !== false && isGeneratedPath(path)) continue;
    if (!matchesGlobs(path, input.globs ?? [])) continue;
    if (isIgnoredPath(path, false, ignoreRules)) continue;
    files.push(path);
  }
  files.sort(comparePaths);

  const matches: SearchMatch[] = [];
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const contextSize = input.context ?? 0;
  const expression = createMatcher(input);
  let truncated = false;
  let visitedLines = 0;
  outer: for (const path of files) {
    throwIfAborted(options.signal);
    const text = await Bun.file(resolve(workspace, path)).text();
    throwIfAborted(options.signal);
    if (text.includes("\0")) continue;
    const lines = text.split(/\r\n|\n|\r/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if ((visitedLines++ & 0x7f) === 0) {
        await Bun.sleep(0);
        throwIfAborted(options.signal);
      }
      const line = lines[lineIndex];
      if (line === undefined) continue;
      const column = expression(line);
      if (column === undefined) continue;
      const lineNumber = lineIndex + 1;
      const match: SearchMatch = {
        path,
        line: lineNumber,
        column,
        text: line,
        before: contextLines(lines, Math.max(0, lineIndex - contextSize), lineIndex),
        after: contextLines(
          lines,
          lineIndex + 1,
          Math.min(lines.length, lineIndex + contextSize + 1),
        ),
      };
      matches.push(match);
      await options.onOutput?.({
        stream: "stdout",
        data: `${path}:${lineNumber}:${column}:${line}\n`,
      });
      if (matches.length >= limit) {
        truncated = true;
        break outer;
      }
    }
  }
  throwIfAborted(options.signal);
  return { backend: "fallback", matches, truncated, fallbackReason };
}

function createMatcher(input: SearchInput): (line: string) => number | undefined {
  if (input.regex === true) {
    const expression = new RegExp(input.pattern, input.caseSensitive === false ? "iu" : "u");
    return (line) => {
      const match = expression.exec(line);
      if (!match || match.index === undefined) return undefined;
      return codePointLength(line.slice(0, match.index)) + 1;
    };
  }
  const pattern = input.caseSensitive === false ? input.pattern.toLocaleLowerCase() : input.pattern;
  return (line) => {
    const comparable = input.caseSensitive === false ? line.toLocaleLowerCase() : line;
    const index = comparable.indexOf(pattern);
    return index < 0 ? undefined : codePointLength(line.slice(0, index)) + 1;
  };
}

function contextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly SearchContextLine[] {
  const result: SearchContextLine[] = [];
  for (let index = start; index < end; index += 1) {
    const text = lines[index];
    if (text !== undefined) result.push({ line: index + 1, text });
  }
  return result;
}

function attachContext(
  matches: readonly ParsedMatch[],
  contexts: readonly ParsedContext[],
  contextSize: number,
): readonly SearchMatch[] {
  if (contextSize === 0) return matches.map((match) => ({ ...match, before: [], after: [] }));
  const byPath = new Map<string, ParsedContext[]>();
  for (const context of contexts) {
    const lines = byPath.get(context.path) ?? [];
    lines.push(context);
    byPath.set(context.path, lines);
  }
  return matches.map((match) => {
    const lines = byPath.get(match.path) ?? [];
    return {
      ...match,
      before: lines
        .filter((line) => line.line < match.line && line.line >= match.line - contextSize)
        .map(({ line, text }) => ({ line, text })),
      after: lines
        .filter((line) => line.line > match.line && line.line <= match.line + contextSize)
        .map(({ line, text }) => ({ line, text })),
    };
  });
}

async function consumeTextStream(
  stream: ReadableStream<Uint8Array>,
  consume: (chunk: string) => void | Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    if (chunk.length > 0) await consume(chunk);
  }
  const remaining = decoder.decode();
  if (remaining.length > 0) await consume(remaining);
}

class BoundedText {
  private value_ = "";
  private omitted = 0;

  constructor(private readonly limit: number) {}

  write(value: string): void {
    const remaining = this.limit - this.value_.length;
    if (remaining > 0) this.value_ += value.slice(0, remaining);
    this.omitted += Math.max(0, value.length - Math.max(0, remaining));
  }

  value(): string {
    return this.value_ + (this.omitted > 0 ? `\n[${this.omitted} error characters omitted]` : "");
  }
}

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", minLength: 1 },
    path: { type: "string" },
    regex: { type: "boolean" },
    globs: { type: "array", items: { type: "string", minLength: 1 } },
    hidden: { type: "boolean" },
    respectIgnore: { type: "boolean" },
    ignoreGenerated: { type: "boolean" },
    caseSensitive: { type: "boolean" },
    context: { type: "integer", minimum: 0, maximum: 100 },
    limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT },
  },
  required: ["pattern"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseSearchInput(value: JsonValue): SearchInput {
  if (!isJsonObject(value)) throw new Error("arguments must be an object");
  if (typeof value.pattern !== "string") throw new Error("pattern must be a string");
  const globs = value.globs;
  if (
    globs !== undefined &&
    (!Array.isArray(globs) || !globs.every((glob) => typeof glob === "string"))
  ) {
    throw new Error("globs must be an array of strings");
  }
  return {
    pattern: value.pattern,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.regex === "boolean" ? { regex: value.regex } : {}),
    ...(globs === undefined ? {} : { globs }),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(typeof value.respectIgnore === "boolean" ? { respectIgnore: value.respectIgnore } : {}),
    ...(typeof value.ignoreGenerated === "boolean"
      ? { ignoreGenerated: value.ignoreGenerated }
      : {}),
    ...(typeof value.caseSensitive === "boolean" ? { caseSensitive: value.caseSensitive } : {}),
    ...(typeof value.context === "number" ? { context: value.context } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  };
}

function validateSearchInput(input: SearchInput): void {
  if (input.pattern.length === 0) throw new Error("Search pattern cannot be empty");
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SEARCH_LIMIT) {
    throw new RangeError(`Search limit must be an integer from 1 through ${MAX_SEARCH_LIMIT}`);
  }
  const context = input.context ?? 0;
  if (!Number.isSafeInteger(context) || context < 0 || context > 100) {
    throw new RangeError("Search context must be an integer from 0 through 100");
  }
  for (const glob of input.globs ?? []) {
    if (glob.length === 0) throw new Error("Search globs cannot be empty");
  }
  if (input.regex === true) new RegExp(input.pattern, "u");
}

function findRipgrep(command: string): string | undefined {
  return Bun.which(command) ?? undefined;
}

function utf8ByteOffsetToColumn(value: string, byteOffset: number): number {
  const bytes = new TextEncoder().encode(value);
  const prefix = new TextDecoder().decode(bytes.slice(0, byteOffset));
  return codePointLength(prefix) + 1;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
