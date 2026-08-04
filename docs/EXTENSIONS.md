# Extensions

Place `.ts`, `.js`, or `.mjs` files in the global extensions directory or `<workspace>/.brisk/extensions/`. Global paths: Linux `~/.config/brisk/extensions/`, macOS `~/Library/Application Support/Brisk/extensions/`, Windows `%APPDATA%\Brisk\extensions\`.

Load order: global (sorted), then project (sorted). **Project extensions require one-time approval** per process.

Default-export an activation function (or `{ activate }`). Return optional cleanup.

```ts
export default function activate(brisk) {
  brisk.registerSlashCommand({
    name: "hello",
    description: "greeting",
    execute({ arguments: name }) {
      return `hello ${name || "world"}`;
    },
  });
}
```

## API

- `registerTool`, `registerSlashCommand`, `registerKeybinding`
- `contributeUi({ id, slot, text, priority? })` — slots: `header`, `sidebar`, `status`, `composer`
- `onLifecycle(event, hook)` — `extensions-loaded`, `session-start`, `session-end`, `turn-start`, `turn-end`, `shutdown`

Built-in names win over extensions. `/reload` loads a new generation. Failures are isolated and logged for `brisk doctor`. Extensions are not sandboxed—same OS privileges as Brisk.
