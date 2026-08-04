import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const COMMON_GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  "target",
  "vendor",
]);

export interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly hasSlash: boolean;
  readonly matcher: Bun.Glob;
}

export async function resolveWorkspacePath(
  workspace: string,
  child = ".",
  requireDirectory = true,
): Promise<{
  readonly workspace: string;
  readonly path: string;
  readonly relative: string;
  readonly insideWorkspace: boolean;
}> {
  const workspacePath = await realpath(resolve(workspace));
  const authoredAbsolute = isAbsolute(child);
  const candidate = authoredAbsolute ? resolve(child) : resolve(workspacePath, child);
  if (!authoredAbsolute) assertContained(workspacePath, candidate);
  const resolvedCandidate = await realpath(candidate);
  const insideWorkspace = isContained(workspacePath, resolvedCandidate);
  if (!authoredAbsolute && !insideWorkspace) {
    throw new Error(`Relative path escapes workspace through a symlink: ${child}`);
  }
  if (requireDirectory) {
    const entry = await lstat(resolvedCandidate);
    if (!entry.isDirectory()) throw new Error(`Path is not a directory: ${child}`);
  }
  return {
    workspace: workspacePath,
    path: resolvedCandidate,
    relative: stableRelative(workspacePath, resolvedCandidate),
    insideWorkspace,
  };
}

export function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate))
    throw new Error(`Relative path escapes workspace: ${candidate}`);
}

export function stableRelative(root: string, path: string): string {
  const absolute = resolve(path);
  if (!isContained(root, absolute)) return absolute.split(sep).join("/");
  const value = relative(root, absolute).split(sep).join("/");
  return value === "" ? "." : value;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function normalizeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

export function isHiddenPath(path: string): boolean {
  return normalizeRelative(path)
    .split("/")
    .some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

export function isGeneratedPath(path: string): boolean {
  return normalizeRelative(path)
    .split("/")
    .some((part) => COMMON_GENERATED_DIRECTORIES.has(part));
}

export async function loadIgnoreRules(workspace: string): Promise<readonly IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const filename of [".gitignore", ".ignore", ".rgignore"]) {
    let content: string;
    try {
      content = await readFile(resolve(workspace, filename), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const sourceLine of content.split(/\r?\n/)) {
      const rule = parseIgnoreRule(sourceLine);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

export function isIgnoredPath(
  path: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  const relativePath = normalizeRelative(path).replace(/\/$/, "");
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !matchesDirectoryRule(relativePath, isDirectory, rule)) continue;
    if (!rule.directoryOnly && !matchesRule(relativePath, rule)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

export function matchesGlobs(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return true;
  const normalized = normalizeRelative(path);
  const positive = globs.filter((glob) => !glob.startsWith("!"));
  if (positive.length > 0 && !positive.some((glob) => globMatches(normalized, glob))) return false;
  return !globs
    .filter((glob) => glob.startsWith("!") && glob.length > 1)
    .some((glob) => globMatches(normalized, glob.slice(1)));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
  }
}

function parseIgnoreRule(sourceLine: string): IgnoreRule | undefined {
  let line = sourceLine.trim();
  if (line.length === 0 || line.startsWith("#")) return undefined;
  if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  if (line.length === 0) return undefined;
  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  const directoryOnly = line.endsWith("/");
  if (directoryOnly) line = line.slice(0, -1);
  if (line.length === 0) return undefined;
  const hasSlash = line.includes("/");
  return {
    pattern: line,
    negated,
    directoryOnly,
    anchored,
    hasSlash,
    matcher: new Bun.Glob(line),
  };
}

function matchesRule(path: string, rule: IgnoreRule): boolean {
  if (rule.anchored || rule.hasSlash) {
    return rule.matcher.match(path) || path.startsWith(`${rule.pattern}/`);
  }
  const parts = path.split("/");
  return parts.some((part) => rule.matcher.match(part));
}

function matchesDirectoryRule(path: string, isDirectory: boolean, rule: IgnoreRule): boolean {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index + 1).join("/");
    const part = parts[index];
    if (part === undefined) continue;
    const matches =
      rule.anchored || rule.hasSlash ? rule.matcher.match(prefix) : rule.matcher.match(part);
    if (matches && (index < parts.length - 1 || isDirectory)) return true;
  }
  return false;
}

function globMatches(path: string, pattern: string): boolean {
  const matcher = new Bun.Glob(pattern);
  if (matcher.match(path)) return true;
  return !pattern.includes("/") && path.split("/").some((part) => matcher.match(part));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
