import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  applyEdits,
  getLocation,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
  type ParseOptions,
} from "jsonc-parser";
import { z } from "zod";

const serverNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const boundedString = z.string().max(100_000);
const timeoutSchema = z
  .number()
  .int()
  .min(1_000)
  .max(60 * 60 * 1_000)
  .default(60_000);

export const stdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(256).default([]),
    env: z.record(environmentNameSchema, boundedString).optional(),
    cwd: z.string().trim().min(1).max(16_384).optional(),
    enabled: z.boolean().default(true),
    timeoutMs: timeoutSchema,
  })
  .strict();

export const httpMcpServerSchema = z
  .object({
    type: z.enum(["http", "streamable-http"]).optional(),
    url: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
        message: "MCP URL must use http or https",
      })
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "";
      }, "MCP URL must not contain inline credentials"),
    headers: z.record(z.string().trim().min(1).max(256), boundedString).optional(),
    enabled: z.boolean().default(true),
    timeoutMs: timeoutSchema,
  })
  .strict();

export const mcpServerSchema = z.union([stdioMcpServerSchema, httpMcpServerSchema]);

export const mcpConfigSchema = z
  .object({
    mcpServers: z.record(serverNameSchema, mcpServerSchema).default({}),
  })
  .strict();

export type StdioMcpServerConfig = z.infer<typeof stdioMcpServerSchema>;
export type HttpMcpServerConfig = z.infer<typeof httpMcpServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

const parseOptions: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
};

export class McpConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpConfigError";
  }
}

export async function loadMcpConfig(filePath: string): Promise<McpConfig> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return mcpConfigSchema.parse({});
    throw new McpConfigError(`Unable to read ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return parseMcpConfigText(source, filePath);
}

export function parseMcpConfigText(source: string, filePath = "<mcp.json>"): McpConfig {
  const syntaxErrors: ParseError[] = [];
  const value: unknown = parse(source, syntaxErrors, parseOptions);
  if (syntaxErrors.length > 0) {
    const messages = syntaxErrors.map((error) => {
      const location = getLocation(source, error.offset);
      return `${formatPath(location.path)}: JSONC syntax error: ${printParseErrorCode(error.error)}`;
    });
    throw new McpConfigError(`${filePath}\n${messages.join("\n")}`);
  }

  const result = mcpConfigSchema.safeParse(value);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      );
      return `${formatPath(path)}: ${issue.message}`;
    });
    throw new McpConfigError(`${filePath}\n${messages.join("\n")}`);
  }
  return result.data;
}

/** Atomically add, replace, or remove one server while preserving JSONC comments. */
export async function writeMcpServer(
  filePath: string,
  name: string,
  server: McpServerConfig | undefined,
): Promise<void> {
  serverNameSchema.parse(name);
  if (server !== undefined) mcpServerSchema.parse(server);
  await updateMcpConfig(filePath, ["mcpServers", name], server);
}

export async function writeMcpServerEnabled(
  filePath: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  serverNameSchema.parse(name);
  const current = await loadMcpConfig(filePath);
  if (!current.mcpServers[name]) throw new McpConfigError(`Unknown MCP server: ${name}`);
  await updateMcpConfig(filePath, ["mcpServers", name, "enabled"], enabled);
}

async function updateMcpConfig(
  filePath: string,
  path: readonly string[],
  value: unknown,
): Promise<void> {
  const source = await readOptionalText(filePath);
  const base = source?.trim() ? source : '{\n  "mcpServers": {}\n}\n';
  parseMcpConfigText(base, filePath);

  let candidate: string;
  try {
    candidate = applyEdits(
      base,
      modify(base, [...path], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  } catch (error) {
    throw new McpConfigError(`Unable to update ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!candidate.endsWith("\n")) candidate += "\n";
  parseMcpConfigText(candidate, filePath);
  await atomicWrite(filePath, candidate);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.mcp.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch (error) {
    throw new McpConfigError(`Unable to publish ${filePath}: ${errorMessage(error)}`, {
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
    throw error;
  }
}

function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
          ? `${result}.${segment}`
          : `${result}[${JSON.stringify(segment)}]`,
    "$",
  );
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
