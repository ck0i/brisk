import type { ToolCall } from "../core/messages.ts";

export function summarizeToolCall(call: ToolCall): string | undefined {
  const arguments_ = parseArguments(call.arguments);
  if (!arguments_) return undefined;

  if (call.name === "read" || call.name === "write") {
    return typeof arguments_.path === "string" ? compact(arguments_.path) : undefined;
  }
  if (call.name === "task" && typeof arguments_.description === "string") {
    return compact(arguments_.description);
  }
  if (call.name === "task_status" && typeof arguments_.childSessionId === "string") {
    return compact(arguments_.childSessionId);
  }
  if (call.name === "mcp_search" && typeof arguments_.query === "string") {
    return compact(arguments_.query || "all tools");
  }
  if (
    (call.name === "mcp_describe" || call.name === "mcp_call") &&
    typeof arguments_.server === "string" &&
    typeof arguments_.tool === "string"
  ) {
    return compact(`${arguments_.server}/${arguments_.tool}`);
  }
  if (call.name === "edit" && typeof arguments_.patch === "string") {
    const paths = [
      ...new Set(
        [...arguments_.patch.matchAll(/^\[([^\]#]+)#[^\]]+\]/gm)]
          .map((match) => match[1])
          .filter((path): path is string => path !== undefined),
      ),
    ];
    return paths.length === 0 ? undefined : compact(paths.join(", "));
  }
  return undefined;
}

export function summarizeToolResult(toolName: string, content: string): string {
  if (toolName === "task" || toolName === "task_status") {
    const result = parseTaskResult(content);
    if (result && typeof result.summary === "string") return compact(result.summary);
  }
  const firstLine = content.split("\n", 1)[0] ?? "";
  return compact(firstLine);
}

export function extractToolDiff(toolName: string, content: string): string | undefined {
  if (toolName === "edit" || toolName === "write") {
    const direct = content.startsWith("--- ") ? 0 : content.indexOf("\n--- ") + 1;
    if (direct >= 0 && content.slice(direct).includes("\n+++ ")) return content.slice(direct);
    return undefined;
  }
  if (toolName !== "task" && toolName !== "task_status") return undefined;

  const result = parseTaskResult(content);
  if (!result || typeof result.patch !== "string") return undefined;
  return isUnifiedDiff(result.patch) ? result.patch : undefined;
}

function parseTaskResult(content: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isUnifiedDiff(value: string): boolean {
  return /(?:^|\n)--- [^\n]+\n\+\+\+ [^\n]+\n@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(value);
}

function parseArguments(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function compact(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 97)}...`;
}
