import { createInterface } from "node:readline";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

lines.on("line", (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  if (request.id === undefined) return;

  switch (request.method) {
    case "server/discover":
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32_601, message: "Legacy MCP fixture" },
      });
      break;
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "brisk-test-mcp", version: "1.0.0" },
          instructions: "Fixture instructions",
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo a value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const params = isRecord(request.params) ? request.params : {};
      const arguments_ = isRecord(params.arguments) ? params.arguments : {};
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: `echo:${String(arguments_.value ?? "")}` }],
        },
      });
      break;
    }
    case "ping":
      send({ jsonrpc: "2.0", id: request.id, result: {} });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32_601, message: `Unknown method: ${request.method}` },
      });
  }
});

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
