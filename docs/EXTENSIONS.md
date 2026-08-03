# Extensions

Brisk extensions are `.ts`, `.js`, or `.mjs` files placed directly in the global extension directory or `<workspace>/.brisk/extensions/`. The global directory is `$XDG_CONFIG_HOME/brisk/extensions/` on Linux (normally `~/.config/brisk/extensions/`), `~/Library/Application Support/Brisk/extensions/` on macOS, and `%APPDATA%\\Brisk\\extensions\\` on Windows. Files load after the first TUI draw in deterministic order: global entries first, then project entries, sorted by canonical path. Project code is never imported until the approval dialog allows it; the decision is cached for that Brisk process.

An extension default-exports an activation function (or `{ activate }`). Activation may return a cleanup function or `{ dispose() }`.

```ts
export default function activate(brisk) {
  brisk.registerSlashCommand({
    name: "hello",
    description: "print a greeting",
    execute({ arguments: name, signal }) {
      if (signal.aborted) return;
      return `hello ${name || "world"}`;
    },
  });

  brisk.contributeUi({
    id: "hello-status",
    slot: "status",
    text: "hello loaded",
    priority: 10,
  });

  brisk.onLifecycle("session-start", ({ data }) => {
    // react to a session without blocking other extensions
  });

  return () => {
    // release resources created outside Brisk registrations
  };
}
```

## Context API

`BriskExtensionContext` is the complete host API exposed to extension code:

- `extension`: immutable `{ id, path, root, source }` metadata. `source` is `global` or `project`.
- `signal`: aborted before reload or disposal.
- `registerTool(definition)`: registers a validated `ToolDefinition`.
- `registerSlashCommand({ name, description, execute })`.
- `registerKeybinding({ key, description, execute })`.
- `contributeUi({ id, slot, text, priority? })`: `slot` is `header`, `sidebar`, `status`, or `composer`.
- `onLifecycle(event, hook)`: events are `extensions-loaded`, `session-start`, `session-end`, `turn-start`, `turn-end`, and `shutdown`.

Every registration returns an idempotent `{ dispose() }`. Brisk also removes all registrations and hooks automatically when reloading or disposing the extension. Built-in tools and commands take precedence over extension names. Run `/reload` to re-read configuration and load a fresh extension module generation; active agent services are rebuilt around the new tool registry without rewriting the session transcript.

Extension failures are redacted, attributed, isolated from sibling extensions, and written to `errors.json` in the global extension directory for `brisk doctor`. Global extensions execute without a project prompt. Approved project extensions and global extensions execute with the same operating-system permissions as Brisk; this is an application API boundary, not an OS sandbox.

Registration input and callback output are runtime-validated. Duplicate names or keys keep the first deterministic registration and produce a diagnostic. Import, activation, tool, command, keybinding, hook, and cleanup failures are attributed to the extension and isolated from sibling extensions.
