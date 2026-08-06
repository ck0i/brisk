# Model Context Protocol (MCP)

Brisk connects to local stdio and remote Streamable HTTP MCP servers. Configure servers in the user-level `mcp.json`, or use `/mcp` in the TUI to add and manage them.

## Config file

`mcp.json` lives beside `config.jsonc`:

| Platform | Path                                           |
| -------- | ---------------------------------------------- |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/brisk/mcp.json` |
| macOS    | `~/Library/Application Support/Brisk/mcp.json` |
| Windows  | `%APPDATA%\Brisk\mcp.json`                     |

The file accepts comments and trailing commas. Brisk writes it atomically with private `0600` permissions on POSIX systems.

Local stdio example:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}",
        "LOG_LEVEL": "warning",
      },
      "timeoutMs": 60000,
      "enabled": true,
    },
  },
}
```

Brisk spawns `command` directly without a shell. `args` is an exact string array. `cwd` is optional and resolves relative to the active workspace; it defaults to the workspace. A configured `env` is merged with the MCP SDK's conservative default inherited environment. `${NAME}` placeholders are resolved from Brisk's environment at connection time and missing variables fail that server without preventing other servers from loading.

Remote Streamable HTTP example:

```jsonc
{
  "mcpServers": {
    "company": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COMPANY_MCP_TOKEN}",
      },
      "timeoutMs": 60000,
      "enabled": true,
    },
  },
}
```

URLs may use `http` or `https` and cannot contain username/password credentials. Environment placeholders are recommended for header credentials. Brisk currently supports pre-provisioned headers rather than running an interactive MCP OAuth flow.

## Interactive management

`/mcp` opens a keyboard-first server menu. It can add stdio or Streamable HTTP servers, show status, enable or disable entries, reconnect, reload `mcp.json`, and remove entries. `/mcp add`, `/mcp status`, and `/mcp reload` are direct shortcuts. Operations that would reconnect servers wait for an active agent run to finish.

Advanced fields such as `env`, `headers`, and `cwd` can be added in `mcp.json`, followed by `/mcp reload`.

## Token-efficient tools

Brisk does not insert every remote tool schema into every provider request. Connected-server catalogs are cached in memory, paginated by the official SDK, and refreshed on MCP tool-list change notifications. The model sees three stable meta-tools only when at least one server is connected:

- `mcp_search` returns a bounded list of names and one-line descriptions.
- `mcp_describe` returns the full schema for one selected tool.
- `mcp_call` invokes that exact server/tool pair.

This follows the MCP project's [progressive discovery guidance](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices): catalog → inspect → execute. The stable meta-tool schemas preserve prompt-cache prefixes, while large call results use Brisk's normal output limiter and private `artifact://` storage.

## Permissions and data

MCP servers and their descriptions, instructions, annotations, and results are external data. Brisk does not treat them as instructions. Tool annotations such as `readOnlyHint` are displayed but are not trusted as an authorization boundary. In `safe` and `write` modes every MCP call requires approval; the approval shows the arguments, and a session approval is scoped to that exact server/tool/arguments combination. `yolo` permits calls without prompting.

Configured environment values and header placeholders are redacted from connection errors and text results when possible. Do not put credentials in command arguments or URLs. Data sent to a remote MCP server is governed by that server's policies.

Brisk currently exposes MCP tools to the coding agent. MCP resources, prompts, server-side sampling, and elicitation do not yet have Brisk UI surfaces.
