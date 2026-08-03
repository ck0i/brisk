import type { z } from "zod";

import {
  formatConfigPath,
  parseConfigText,
  validateConfigLayer,
  type ConfigDiagnostic,
  type ConfigPathSegment,
} from "./diagnostics.ts";
import { projectConfigPath, type ConfigPaths } from "./paths.ts";
import { configSchema, DEFAULT_CONFIG, type BriskConfig, type ConfigOverrides } from "./schema.ts";

export interface LoadConfigOptions {
  readonly paths: ConfigPaths;
  readonly workspace?: string;
  readonly cliOverrides?: ConfigOverrides;
  readonly runtimeOverrides?: ConfigOverrides;
}

export interface LoadedConfig {
  readonly config: BriskConfig;
  readonly diagnostics: readonly ConfigDiagnostic[];
}

export class ConfigLoadError extends Error {
  readonly diagnostics: readonly ConfigDiagnostic[];

  constructor(diagnostics: readonly ConfigDiagnostic[]) {
    super(formatLoadError(diagnostics));
    this.name = "ConfigLoadError";
    this.diagnostics = diagnostics;
  }
}

interface Layer {
  readonly source: string;
  readonly value: ConfigOverrides;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const diagnostics: ConfigDiagnostic[] = [];
  const layers: Layer[] = [];

  const globalPath = options.paths.globalConfigPath;
  const globalLayer = await readConfigFile(globalPath);
  if (globalLayer !== undefined) collectLayer(globalLayer, globalPath, layers, diagnostics);

  if (options.workspace !== undefined) {
    const projectPath = projectConfigPath(options.workspace, options.paths.platform);
    const projectLayer = await readConfigFile(projectPath);
    if (projectLayer !== undefined) collectLayer(projectLayer, projectPath, layers, diagnostics);
  }

  if (options.cliOverrides !== undefined) {
    collectLayer(validateConfigLayer(options.cliOverrides, "<cli>"), "<cli>", layers, diagnostics);
  }
  if (options.runtimeOverrides !== undefined) {
    collectLayer(
      validateConfigLayer(options.runtimeOverrides, "<runtime>"),
      "<runtime>",
      layers,
      diagnostics,
    );
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ConfigLoadError(diagnostics);
  }

  let merged: unknown = cloneValue(DEFAULT_CONFIG);
  const sources = new Map<string, string>();
  recordSources(DEFAULT_CONFIG, [], "<defaults>", sources);
  for (const layer of layers) {
    merged = deepMerge(merged, layer.value);
    recordSources(layer.value, [], layer.source, sources);
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const mergedDiagnostics = parsed.error.issues.map((issue) =>
      finalSchemaDiagnostic(sourceForPath(issue.path, sources), issue),
    );
    throw new ConfigLoadError([...diagnostics, ...mergedDiagnostics]);
  }

  return { config: parsed.data, diagnostics };
}

async function readConfigFile(
  path: string,
): Promise<ReturnType<typeof parseConfigText> | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return parseConfigText(await file.text(), path);
  } catch (error) {
    throw new ConfigLoadError([
      {
        severity: "error",
        source: path,
        path: "$",
        message: `Unable to read configuration: ${errorMessage(error)}`,
      },
    ]);
  }
}

function collectLayer(
  result: ReturnType<typeof validateConfigLayer>,
  source: string,
  layers: Layer[],
  diagnostics: ConfigDiagnostic[],
): void {
  diagnostics.push(...result.diagnostics);
  if (result.value !== undefined) layers.push({ source, value: result.value });
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (isRecord(base) && isRecord(overlay)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) result[key] = cloneValue(value);
    for (const [key, value] of Object.entries(overlay)) {
      result[key] = key in result ? deepMerge(result[key], value) : cloneValue(value);
    }
    return result;
  }
  return cloneValue(overlay);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    );
  }
  return value;
}

function recordSources(
  value: unknown,
  path: readonly ConfigPathSegment[],
  source: string,
  sources: Map<string, string>,
): void {
  sources.set(pathKey(path), source);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      recordSources(entry, [...path, index], source, sources);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      recordSources(entry, [...path, key], source, sources);
  }
}

function sourceForPath(path: readonly PropertyKey[], sources: ReadonlyMap<string, string>): string {
  const configPath = path.filter(
    (segment): segment is ConfigPathSegment =>
      typeof segment === "string" || typeof segment === "number",
  );
  for (let length = configPath.length; length >= 0; length -= 1) {
    const source = sources.get(pathKey(configPath.slice(0, length)));
    if (source !== undefined) return source;
  }
  return "<configuration>";
}

function pathKey(path: readonly ConfigPathSegment[]): string {
  return JSON.stringify(path);
}

function finalSchemaDiagnostic(source: string, issue: z.core.$ZodIssue): ConfigDiagnostic {
  const path = issue.path.filter(
    (segment): segment is ConfigPathSegment =>
      typeof segment === "string" || typeof segment === "number",
  );
  return {
    severity: "error",
    source,
    path: formatConfigPath(path),
    message: issue.message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatLoadError(diagnostics: readonly ConfigDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return "Configuration load failed";
  return errors
    .map((diagnostic) => `${diagnostic.source} ${diagnostic.path}: ${diagnostic.message}`)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
