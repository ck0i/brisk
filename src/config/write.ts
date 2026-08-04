import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyEdits, modify } from "jsonc-parser";

import type { JsonValue } from "../core/messages.ts";
import { parseConfigText, type ConfigPathSegment } from "./diagnostics.ts";

export class ConfigWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigWriteError";
  }
}

/** Atomically update one global JSONC setting while preserving comments and unrelated fields. */
export async function writeConfigValue(
  filePath: string,
  path: readonly ConfigPathSegment[],
  value: JsonValue | undefined,
): Promise<void> {
  if (path.length === 0) throw new TypeError("Configuration setting path cannot be empty");
  const directory = dirname(filePath);
  const source = await readOptionalText(filePath);
  const base = source?.trim() ? source : "{}\n";
  const existing = parseConfigText(base, filePath);
  const existingErrors = existing.diagnostics.filter((item) => item.severity === "error");
  if (existingErrors.length > 0) {
    throw new ConfigWriteError(formatDiagnostics(existingErrors));
  }

  let candidate: string;
  try {
    candidate = applyEdits(
      base,
      modify(base, [...path], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  } catch (error) {
    throw new ConfigWriteError(`Unable to update ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!candidate.endsWith("\n")) candidate += "\n";

  const validated = parseConfigText(candidate, filePath);
  const errors = validated.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new ConfigWriteError(formatDiagnostics(errors));

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.config.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(candidate, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    throw new ConfigWriteError(`Unable to publish ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new ConfigWriteError(`Unable to read ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function formatDiagnostics(
  diagnostics: readonly {
    readonly source: string;
    readonly path: string;
    readonly message: string;
  }[],
): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.source} ${diagnostic.path}: ${diagnostic.message}`)
    .join("\n");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
