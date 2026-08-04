import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const AGENTS_FILENAME = "AGENTS.md";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
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

export interface AgentsInstructionDiscoveryOptions {
  readonly workspace: string;
  readonly userAgentsPath: string;
}

interface RepositoryAgentsFile {
  readonly path: string;
  readonly scope: string;
  readonly content: string;
}

/** Discover user and recursively scoped repository AGENTS.md instructions. */
export async function discoverAgentsInstructions(
  options: AgentsInstructionDiscoveryOptions,
): Promise<readonly string[]> {
  const workspace = await realpath(resolve(options.workspace));
  const [userContent, repositoryFiles] = await Promise.all([
    readOptionalFile(options.userAgentsPath),
    discoverRepositoryFiles(workspace),
  ]);
  const prompts: string[] = [];

  if (userContent?.trim()) prompts.push(renderUserInstructions(userContent));
  if (repositoryFiles.length > 0) prompts.push(renderRepositoryInstructions(repositoryFiles));
  return prompts;
}

async function discoverRepositoryFiles(workspace: string): Promise<RepositoryAgentsFile[]> {
  const paths: string[] = [];
  await walk(workspace, paths);
  const files = await Promise.all(
    paths.map(async (path): Promise<RepositoryAgentsFile> => {
      const relativePath = stableRelative(workspace, path);
      const directory = relativePath.slice(0, -AGENTS_FILENAME.length).replace(/\/$/, "");
      return {
        path: relativePath,
        scope: directory.length === 0 ? "." : directory,
        content: await readFile(path, "utf8"),
      };
    }),
  );
  return files
    .filter((file) => file.content.trim().length > 0)
    .sort(
      (left, right) =>
        pathDepth(left.path) - pathDepth(right.path) || compare(left.path, right.path),
    );
}

async function walk(directory: string, found: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compare(left.name, right.name));

  for (const entry of entries) {
    if (entry.isFile() && entry.name === AGENTS_FILENAME) {
      found.push(join(directory, entry.name));
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    await walk(join(directory, entry.name), found);
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function renderUserInstructions(content: string): string {
  return [
    "## User-level AGENTS.md instructions",
    "",
    "These user defaults apply throughout the workspace, but every applicable repository AGENTS.md file has higher precedence. A direct request from the user remains authoritative.",
    "",
    "### User instruction file",
    content.trimEnd(),
  ].join("\n");
}

function renderRepositoryInstructions(files: readonly RepositoryAgentsFile[]): string {
  const lines = [
    "## Repository AGENTS.md instructions",
    "",
    "Repository instructions take precedence over user-level AGENTS.md instructions. An AGENTS.md file applies only to files in its containing directory and descendants. For a target file, apply the workspace-root file and every AGENTS.md file in ancestor directories; a deeper applicable file takes precedence over a shallower one. Files below are ordered from broader to more specific scope. Instructions from unrelated directory scopes do not apply.",
  ];

  for (const file of files) {
    lines.push(
      "",
      "### Repository instruction file",
      JSON.stringify({
        path: file.path,
        scope: file.scope === "." ? "entire workspace" : `${file.scope}/**`,
      }),
      file.content.trimEnd(),
    );
  }
  return lines.join("\n");
}

function stableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
