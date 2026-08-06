import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

import type { JsonValue } from "../../src/core/messages.ts";
import {
  McpRuntime,
  type McpClientConnection,
  type McpConnectorOptions,
} from "../../src/mcp/runtime.ts";
import { PermissionManager, type ApprovalRequest } from "../../src/tools/approval.ts";
import { ArtifactStore } from "../../src/tools/artifact-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpRuntime", () => {
  test("uses progressive discovery, refreshes catalogs, approves calls, and closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-mcp-runtime-"));
    roots.push(root);
    const configPath = join(root, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          demo: { command: "fixture", env: { TOKEN: "${MCP_TEST_TOKEN}" } },
        },
      }),
    );

    const initialTools: Tool[] = [
      {
        name: "lookup_record",
        title: "Lookup record",
        description: "Find one customer record by identifier (super-secret-fixture)",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "delete_record",
        description: "Delete a customer record",
        inputSchema: { type: "object" },
      },
    ];
    let tools = initialTools;
    let changeHandler: McpConnectorOptions["onToolsChanged"] | undefined;
    let closed = 0;
    const calls: Array<{ name: string; arguments: Readonly<Record<string, JsonValue>> }> = [];
    const connection: McpClientConnection = {
      instructions: "Use tenant identifiers returned by the service.",
      async listTools() {
        return tools;
      },
      async callTool(name, arguments_) {
        calls.push({ name, arguments: arguments_ });
        return {
          content: [
            {
              type: "text",
              text: `record:${String(arguments_.id)} token=super-secret-fixture`,
            },
          ],
          structuredContent: { found: true },
        } satisfies CallToolResult;
      },
      async close() {
        closed += 1;
      },
    };
    const approvals: ApprovalRequest[] = [];
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    await artifacts.initialize();
    const runtime = new McpRuntime({
      configPath,
      workspace: root,
      artifacts,
      permissions: new PermissionManager({
        mode: "write",
        workspace: root,
        handler: {
          async requestApproval(request) {
            approvals.push(request);
            return "approve_once";
          },
        },
      }),
      environment: { MCP_TEST_TOKEN: "super-secret-fixture" },
      connector: async (_name, _config, options) => {
        changeHandler = options.onToolsChanged;
        return connection;
      },
    });

    expect(await runtime.reload()).toEqual({
      configured: 1,
      connected: 1,
      disabled: 0,
      failed: 0,
      tools: 2,
    });
    const registry = new ToolRegistry();
    runtime.installTools(registry);
    expect(registry.schemas.map((schema) => schema.name)).toEqual([
      "mcp_search",
      "mcp_describe",
      "mcp_call",
    ]);
    expect(JSON.stringify(registry.schemas)).not.toContain("lookup_record");
    expect(JSON.stringify(registry.schemas)).not.toContain('"id"');

    const [search] = await registry.execute(
      [{ id: "search", name: "mcp_search", arguments: '{"query":"customer lookup"}' }],
      new AbortController().signal,
    );
    expect(search?.content).toContain("lookup_record");
    expect(search?.content).not.toContain("inputSchema");
    expect(search?.content).not.toContain("super-secret-fixture");

    const [describe] = await registry.execute(
      [
        {
          id: "describe",
          name: "mcp_describe",
          arguments: '{"server":"demo","tool":"lookup_record"}',
        },
      ],
      new AbortController().signal,
    );
    expect(describe?.content).toContain('"inputSchema"');
    expect(describe?.content).toContain('"serverInstructions"');

    const [called] = await registry.execute(
      [
        {
          id: "call",
          name: "mcp_call",
          arguments: '{"server":"demo","tool":"lookup_record","arguments":{"id":"abc"}}',
        },
      ],
      new AbortController().signal,
    );
    expect(called?.isError).toBeUndefined();
    expect(called?.content).toContain("record:abc");
    expect(called?.content).toContain("[REDACTED]");
    expect(called?.content).not.toContain("super-secret-fixture");
    expect(called?.content).toContain('"found":true');
    expect(calls).toEqual([{ name: "lookup_record", arguments: { id: "abc" } }]);
    expect(approvals[0]).toMatchObject({
      toolName: "mcp:demo:lookup_record",
      command: '{"id":"abc"}',
    });

    tools = [
      {
        name: "new_tool",
        description: "A newly announced tool",
        inputSchema: { type: "object" },
      },
    ];
    changeHandler?.(undefined, tools);
    expect(runtime.statuses[0]?.toolCount).toBe(1);
    const [refreshed] = await registry.execute(
      [{ id: "refresh", name: "mcp_search", arguments: '{"query":"newly"}' }],
      new AbortController().signal,
    );
    expect(refreshed?.content).toContain("new_tool");

    await runtime.close();
    expect(closed).toBe(1);
  });

  test("isolates connection failures and honors disabled servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-mcp-failures-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const configPath = join(root, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          off: { command: "off", enabled: false },
          broken: { url: "https://example.test/mcp" },
        },
      }),
    );
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    await artifacts.initialize();
    const runtime = new McpRuntime({
      configPath,
      workspace: root,
      artifacts,
      permissions: new PermissionManager({
        mode: "yolo",
        workspace: root,
        handler: { requestApproval: async () => "deny" },
      }),
      connector: async () => {
        throw new Error("connection refused");
      },
    });

    expect(await runtime.reload()).toEqual({
      configured: 2,
      connected: 0,
      disabled: 1,
      failed: 1,
      tools: 0,
    });
    expect(runtime.statuses).toEqual([
      expect.objectContaining({ name: "broken", state: "failed", error: "connection refused" }),
      expect.objectContaining({ name: "off", state: "disabled" }),
    ]);
    await runtime.close();
  });

  test("isolates a server whose secret environment placeholder is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-mcp-missing-secret-"));
    roots.push(root);
    const configPath = join(root, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          broken: { command: "fixture", env: { API_TOKEN: "Bearer ${MISSING_TOKEN}" } },
        },
      }),
    );
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    await artifacts.initialize();
    const runtime = new McpRuntime({
      configPath,
      workspace: root,
      artifacts,
      permissions: new PermissionManager({
        mode: "yolo",
        workspace: root,
        handler: { requestApproval: async () => "deny" },
      }),
      environment: {},
    });

    expect(await runtime.reload()).toEqual({
      configured: 1,
      connected: 0,
      disabled: 0,
      failed: 1,
      tools: 0,
    });
    expect(runtime.statuses[0]).toMatchObject({
      name: "broken",
      state: "failed",
      error: "Environment variable MISSING_TOKEN is not set",
    });
    await runtime.close();
  });
});
