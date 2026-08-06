import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { ToolContext } from "../../src/tools/registry.ts";
import { connectMcpServer } from "../../src/mcp/runtime.ts";

describe("MCP stdio transport", () => {
  test("negotiates a legacy server, lists tools, calls one, and closes", async () => {
    const connection = await connectMcpServer(
      "fixture",
      {
        type: "stdio",
        command: process.execPath,
        args: [resolve(import.meta.dir, "../fixtures/mcp-stdio-server.ts")],
        enabled: true,
        timeoutMs: 10_000,
      },
      {
        workspace: process.cwd(),
        environment: process.env,
        onToolsChanged() {},
      },
    );
    try {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(connection.instructions).toBe("Fixture instructions");
      const tool = tools[0];
      if (!tool) throw new Error("Fixture MCP tool is missing");
      const result = await connection.callTool(
        "echo",
        { value: "hello" },
        tool,
        toolContext(),
        5_000,
      );
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
    } finally {
      await connection.close();
    }
  }, 20_000);
});

function toolContext(): ToolContext {
  return {
    signal: new AbortController().signal,
    callId: "fixture-call",
    toolName: "echo",
    emitOutput() {},
    emitPreview() {},
  };
}
