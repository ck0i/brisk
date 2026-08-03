import {
  getLocation,
  parse,
  printParseErrorCode,
  type ParseError,
  type ParseOptions,
} from "jsonc-parser";
import type { z } from "zod";

import { configLayerSchema, type ConfigOverrides } from "./schema.ts";

export type ConfigPathSegment = string | number;

export interface ConfigDiagnostic {
  readonly severity: "error" | "warning";
  readonly source: string;
  readonly path: string;
  readonly message: string;
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
}

export interface ConfigParseResult {
  readonly value?: ConfigOverrides;
  readonly diagnostics: readonly ConfigDiagnostic[];
}

const parseOptions: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
};

const topLevelFields = new Set([
  "defaultModel",
  "permissionMode",
  "maxSubagents",
  "maxSubagentDepth",
  "compaction",
  "ui",
  "providers",
]);
const compactionFields = new Set(["enabled", "thresholdPercent", "keepRecentTokens"]);
const uiFields = new Set(["theme", "showThinking"]);
const providerFields = new Set(["type", "baseUrl", "apiKeyEnv", "keyless", "api", "models"]);
const modelFields = new Set([
  "id",
  "contextWindow",
  "maxOutputTokens",
  "input",
  "toolCalling",
  "name",
]);
const inlineSecretFields = new Set([
  "apikey",
  "token",
  "accesstoken",
  "secret",
  "password",
  "authorization",
]);

export function parseConfigText(text: string, source: string): ConfigParseResult {
  const syntaxErrors: ParseError[] = [];
  const value: unknown = parse(text, syntaxErrors, parseOptions);
  if (syntaxErrors.length > 0) {
    return {
      diagnostics: syntaxErrors.map((error) => syntaxDiagnostic(text, source, error)),
    };
  }
  return validateConfigLayer(value, source);
}

export function validateConfigLayer(value: unknown, source: string): ConfigParseResult {
  const diagnostics = collectStructuralDiagnostics(value, source);
  const parsed = configLayerSchema.safeParse(value);
  if (!parsed.success) {
    diagnostics.push(...parsed.error.issues.map((issue) => schemaDiagnostic(source, issue)));
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error") || !parsed.success) {
    return { diagnostics };
  }
  return { value: parsed.data, diagnostics };
}

export function formatConfigPath(segments: readonly ConfigPathSegment[]): string {
  let result = "$";
  for (const segment of segments) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      result += `.${segment}`;
    } else {
      result += `[${JSON.stringify(segment)}]`;
    }
  }
  return result;
}

function syntaxDiagnostic(text: string, source: string, error: ParseError): ConfigDiagnostic {
  const location = getLocation(text, error.offset);
  const position = lineAndColumn(text, error.offset);
  return {
    severity: "error",
    source,
    path: formatConfigPath(location.path),
    message: `JSONC syntax error: ${printParseErrorCode(error.error)}`,
    offset: error.offset,
    line: position.line,
    column: position.column,
  };
}

function schemaDiagnostic(source: string, issue: z.core.$ZodIssue): ConfigDiagnostic {
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

function collectStructuralDiagnostics(value: unknown, source: string): ConfigDiagnostic[] {
  if (!isRecord(value)) return [];

  const diagnostics: ConfigDiagnostic[] = [];
  warnUnknownFields(value, topLevelFields, [], source, diagnostics);

  const compaction = value.compaction;
  if (isRecord(compaction)) {
    warnUnknownFields(compaction, compactionFields, ["compaction"], source, diagnostics);
  }

  const ui = value.ui;
  if (isRecord(ui)) warnUnknownFields(ui, uiFields, ["ui"], source, diagnostics);

  const providers = value.providers;
  if (!isRecord(providers)) return diagnostics;

  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    const providerPath: ConfigPathSegment[] = ["providers", providerName];
    for (const field of Object.keys(provider)) {
      if (isInlineSecretField(field)) {
        diagnostics.push({
          severity: "error",
          source,
          path: formatConfigPath([...providerPath, field]),
          message: "Inline secrets are not allowed; use apiKeyEnv instead",
        });
      } else if (!providerFields.has(field)) {
        diagnostics.push(unknownFieldDiagnostic(source, [...providerPath, field]));
      }
    }

    if (!Array.isArray(provider.models)) continue;
    for (const [index, model] of provider.models.entries()) {
      if (isRecord(model)) {
        warnUnknownFields(
          model,
          modelFields,
          [...providerPath, "models", index],
          source,
          diagnostics,
        );
      }
    }
  }

  return diagnostics;
}

function warnUnknownFields(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
  path: readonly ConfigPathSegment[],
  source: string,
  diagnostics: ConfigDiagnostic[],
): void {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) diagnostics.push(unknownFieldDiagnostic(source, [...path, field]));
  }
}

function unknownFieldDiagnostic(
  source: string,
  path: readonly ConfigPathSegment[],
): ConfigDiagnostic {
  return {
    severity: "warning",
    source,
    path: formatConfigPath(path),
    message: "Unknown configuration field was ignored",
  };
}

function isInlineSecretField(field: string): boolean {
  return inlineSecretFields.has(field.replaceAll("_", "").replaceAll("-", "").toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineAndColumn(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const prefix = text.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n");
  return {
    line: prefix.split("\n").length,
    column: offset - lineStart,
  };
}
