import { readdir, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type { ExtensionIdentity, ExtensionSource } from "./types.ts";

const supportedExtensions = new Set([".ts", ".js", ".mjs"]);

export interface ExtensionDiscoveryIssue {
  readonly source: ExtensionSource;
  readonly path: string;
  readonly message: string;
}

export interface ExtensionDiscoveryResult {
  readonly extensions: readonly ExtensionIdentity[];
  readonly issues: readonly ExtensionDiscoveryIssue[];
}

export interface ExtensionDiscoveryOptions {
  readonly globalDirectories?: readonly string[];
  readonly projectDirectories?: readonly string[];
}

/** Discover direct child extension entry files, globally first and then by canonical path. */
export async function discoverExtensions(
  options: ExtensionDiscoveryOptions,
): Promise<ExtensionDiscoveryResult> {
  const extensions: ExtensionIdentity[] = [];
  const issues: ExtensionDiscoveryIssue[] = [];
  const seenEntries = new Set<string>();

  for (const source of ["global", "project"] as const) {
    const supplied =
      source === "global" ? (options.globalDirectories ?? []) : (options.projectDirectories ?? []);
    const directories = [...new Set(supplied.map((directory) => resolve(directory)))].sort(compare);

    for (const requestedDirectory of directories) {
      let root: string;
      try {
        root = await realpath(requestedDirectory);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        issues.push({
          source,
          path: requestedDirectory,
          message: `Cannot resolve extension directory: ${errorMessage(error)}`,
        });
        continue;
      }

      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        issues.push({
          source,
          path: root,
          message: `Cannot read extension directory: ${errorMessage(error)}`,
        });
        continue;
      }

      entries.sort((left, right) => compare(left.name, right.name));
      for (const entry of entries) {
        if (!entry.isFile() || !supportedExtensions.has(extname(entry.name))) continue;
        const path = join(root, entry.name);
        let canonicalPath: string;
        try {
          canonicalPath = await realpath(path);
        } catch (error) {
          issues.push({
            source,
            path,
            message: `Cannot resolve extension entry: ${errorMessage(error)}`,
          });
          continue;
        }
        if (seenEntries.has(canonicalPath)) continue;
        seenEntries.add(canonicalPath);
        extensions.push(
          Object.freeze({
            id: `${source}:${canonicalPath}`,
            path: canonicalPath,
            root,
            source,
          }),
        );
      }
    }
  }

  return { extensions, issues };
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isMissingPathError(error: unknown): boolean {
  return isErrorWithCode(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isErrorWithCode(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
