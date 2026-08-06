import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  McpConfigError,
  loadMcpConfig,
  parseMcpConfigText,
  writeMcpServer,
  writeMcpServerEnabled,
} from "../../src/mcp/config.ts";

describe("MCP configuration", () => {
  test("parses stdio and Streamable HTTP servers with defaults", () => {
    const config = parseMcpConfigText(`{
      // Standard MCP host shape
      "mcpServers": {
        "local": { "command": "npx", "args": ["-y", "server"], },
        "remote": {
          "type": "streamable-http",
          "url": "https://mcp.example.test/api",
          "headers": { "Authorization": "Bearer \${MCP_TOKEN}" }
        }
      },
    }`);

    expect(config.mcpServers.local).toMatchObject({
      command: "npx",
      args: ["-y", "server"],
      enabled: true,
      timeoutMs: 60_000,
    });
    expect(config.mcpServers.remote).toMatchObject({
      url: "https://mcp.example.test/api",
      enabled: true,
      timeoutMs: 60_000,
    });
  });

  test("rejects URL credentials, unknown fields, and invalid server names", () => {
    expect(() =>
      parseMcpConfigText(`{
        "mcpServers": {
          "bad name": { "url": "https://user:secret@example.test/mcp", "surprise": true }
        }
      }`),
    ).toThrow(McpConfigError);
  });

  test("atomically preserves comments and private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-mcp-config-"));
    const path = join(root, "config", "mcp.json");
    try {
      await writeFile(path, "", { flag: "a" }).catch(() => undefined);
      await writeMcpServer(path, "local", {
        type: "stdio",
        command: "bun",
        args: ["run", "server.ts"],
        enabled: true,
        timeoutMs: 15_000,
      });
      let text = await readFile(path, "utf8");
      text = text.replace('{\n  "mcpServers"', '{\n  // keep me\n  "mcpServers"');
      await writeFile(path, text);

      await writeMcpServerEnabled(path, "local", false);
      await writeMcpServer(path, "remote", {
        type: "streamable-http",
        url: "http://127.0.0.1:3000/mcp",
        enabled: true,
        timeoutMs: 60_000,
      });

      const updated = await readFile(path, "utf8");
      expect(updated).toContain("// keep me");
      const loaded = await loadMcpConfig(path);
      expect(loaded.mcpServers.local?.enabled).toBe(false);
      const remote = loaded.mcpServers.remote;
      expect(remote && "url" in remote ? remote.url : undefined).toBe("http://127.0.0.1:3000/mcp");
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
