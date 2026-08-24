import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import type { ToolDefinition } from "./registry.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const EXA_SEARCH_TOOL = "web_search_exa";
const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 10;
const MAX_QUERY_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_ERROR_CHARS = 500;

export interface WebSearchInput {
  readonly query: string;
  readonly numResults?: number;
}

export type WebSearchFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WebSearchOptions {
  readonly endpoint?: string;
  readonly fetcher?: WebSearchFetcher;
}

interface SearchRequestOptions extends WebSearchOptions {
  readonly signal: AbortSignal;
}

/** Search the live web through Exa's public MCP endpoint. */
export async function searchWeb(
  input: WebSearchInput,
  options: SearchRequestOptions,
): Promise<string> {
  const normalized = normalizeInput(input);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(options.endpoint ?? EXA_MCP_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "x-exa-source": "brisk",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: EXA_SEARCH_TOOL,
          arguments: {
            query: normalized.query,
            numResults: normalized.numResults,
          },
        },
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason ?? error;
    throw new Error(`Web search request failed: ${errorMessage(error)}`, { cause: error });
  }

  const body = await response.text();
  if (!response.ok) {
    const details = compactRemoteText(body, MAX_ERROR_CHARS);
    const suffix = details.length === 0 ? "" : `: ${details}`;
    throw new Error(`Exa web search returned HTTP ${response.status}${suffix}`);
  }

  const envelope = parseMcpEnvelope(body);
  const rpcError = readObject(envelope.error);
  if (rpcError) {
    const code = typeof rpcError.code === "number" ? ` ${rpcError.code}` : "";
    const message = typeof rpcError.message === "string" ? rpcError.message : "Unknown error";
    throw new Error(`Exa web search error${code}: ${compactRemoteText(message, MAX_ERROR_CHARS)}`);
  }

  const result = readObject(envelope.result);
  if (!result) throw new Error("Exa web search returned no result");
  const content = readTextContent(result.content);
  if (result.isError === true) {
    throw new Error(content || "Exa web search returned an error");
  }
  if (content.length === 0) throw new Error("Exa web search returned empty content");

  const heading = `Web search results for ${JSON.stringify(normalized.query)} (via Exa):\n\n`;
  return limitOutput(heading + content);
}

export function createWebSearchTool(
  options: WebSearchOptions = {},
): ToolDefinition<WebSearchInput> {
  return {
    name: "web_search",
    description:
      "Search the live web and return source titles, URLs, and relevant passages. Use for current information or external facts that are not available in the workspace.",
    inputSchema: WEB_SEARCH_SCHEMA,
    readOnly: true,
    parallelSafe: true,
    timeoutMs: 60_000,
    parse: parseWebSearchInput,
    async execute(input, context) {
      return { content: await searchWeb(input, { ...options, signal: context.signal }) };
    },
  };
}

const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: MAX_QUERY_CHARS,
      description: "A focused web search query.",
    },
    numResults: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULT_COUNT,
      description: `Number of results to return (default ${DEFAULT_RESULT_COUNT}).`,
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseWebSearchInput(value: JsonValue): WebSearchInput {
  const object = requireObject(value);
  if (typeof object.query !== "string") throw new Error("query must be a string");
  if (object.numResults !== undefined && typeof object.numResults !== "number") {
    throw new Error("numResults must be a number");
  }
  return normalizeInput({
    query: object.query,
    ...(typeof object.numResults === "number" ? { numResults: object.numResults } : {}),
  });
}

function normalizeInput(input: WebSearchInput): Required<WebSearchInput> {
  const query = input.query.trim();
  if (query.length === 0) throw new Error("query cannot be empty");
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`query cannot exceed ${MAX_QUERY_CHARS} characters`);
  }
  const numResults = input.numResults ?? DEFAULT_RESULT_COUNT;
  if (!Number.isInteger(numResults) || numResults < 1 || numResults > MAX_RESULT_COUNT) {
    throw new Error(`numResults must be an integer from 1 to ${MAX_RESULT_COUNT}`);
  }
  return { query, numResults };
}

function parseMcpEnvelope(body: string): Readonly<Record<string, unknown>> {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    const parsed = parseJsonObject(payload);
    if (parsed && ("result" in parsed || "error" in parsed)) return parsed;
  }

  const parsed = parseJsonObject(body);
  if (parsed && ("result" in parsed || "error" in parsed)) return parsed;
  throw new Error("Exa web search returned an invalid response");
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return readObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readTextContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      const record = readObject(item);
      return record?.type === "text" && typeof record.text === "string" ? [record.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n\n");
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function limitOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[web search output truncated]`;
}

function compactRemoteText(value: string, limit: number): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
