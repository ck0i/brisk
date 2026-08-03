# Extensions

Brisk extensions are `.ts`, `.js`, or `.mjs` files placed directly in a configured global or project extension directory. Files load in deterministic order: global directories first, then project directories, with directories and entries sorted by canonical path. Project code is never imported until the host's first-use approval callback allows it; denial is cached for the lifetime of the extension manager.

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

Every registration returns an idempotent `{ dispose() }`. Brisk also removes all registrations and hooks automatically when reloading or disposing the extension.

Registration input and callback output are runtime-validated. Duplicate names or keys keep the first deterministic registration and produce a diagnostic. Import, activation, tool, command, keybinding, hook, and cleanup failures are attributed to the extension and isolated from sibling extensions.
