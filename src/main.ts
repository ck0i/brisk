#!/usr/bin/env bun

export {};

const VERSION = "0.1.0";
const startedAt = performance.now();

interface RuntimeController {
  submit(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  cancel(): void;
  dispose(): void;
}

function printHelp(): void {
  process.stdout.write(
    `Brisk ${VERSION}\n\nUsage:\n  brisk [directory]\n  brisk --continue\n  brisk --session <id>\n  brisk auth <login|logout|status> [provider]\n  brisk models\n  brisk sessions\n  brisk doctor\n  brisk bench\n  brisk version\n\nOptions:\n  --model <provider/model>\n  --permission-mode <safe|write|yolo>\n  --fake-provider                 deterministic development provider\n  -h, --help\n`,
  );
}

async function main(): Promise<void> {
  const { parseCliArgs } = await import("./cli/args.ts");
  const command = parseCliArgs(process.argv.slice(2), {
    fakeProviderEnv: process.env.BRISK_FAKE_PROVIDER === "1",
  });
  if (command.name === "version") {
    process.stdout.write(`brisk ${VERSION}\n`);
    return;
  }
  if (command.name === "help") {
    printHelp();
    return;
  }
  if (command.name === "bench") {
    const { benchmarkFirstDraw } = await import("./ui/benchmark.tsx");
    const value = await benchmarkFirstDraw();
    if (command.json) process.stdout.write(`${JSON.stringify({ timeToFirstDrawMs: value })}\n`);
    else process.stdout.write(`Time to first draw (headless): ${value.toFixed(2)} ms\n`);
    return;
  }
  if (command.name !== "tui") {
    throw new Error(
      `${command.name} is not available until provider and session initialization completes`,
    );
  }

  const { basename, resolve } = await import("node:path");
  const workspace = resolve(command.directory);
  const { launchTui } = await import("./app.tsx");
  let controller: RuntimeController | undefined;
  await launchTui({
    workspace: basename(workspace) || workspace,
    mode: command.permissionMode ?? "write",
    startedAt,
    handlers: {
      async initialize(store) {
        const { stat } = await import("node:fs/promises");
        const workspaceStat = await stat(workspace).catch(() => undefined);
        if (!workspaceStat?.isDirectory())
          throw new Error(`Workspace does not exist: ${workspace}`);
        if (!command.fakeProvider) {
          store.update({ status: "ready" });
          return;
        }

        const [{ AgentLoop }, { FakeProvider }, { ToolRegistry }, { AgentUiController }] =
          await Promise.all([
            import("./core/agent-loop.ts"),
            import("./providers/fake-provider.ts"),
            import("./tools/registry.ts"),
            import("./ui/agent-controller.ts"),
          ]);
        const provider = new FakeProvider([
          {
            id: "fake-1",
            thinking: ["Plan the response. ", { value: "Choose a tool.", delayMs: 8 }],
            text: [
              "I will exercise the streaming tool loop. ",
              { value: "Calling echo now.", delayMs: 8 },
            ],
            toolCalls: [
              {
                id: "fake-echo",
                name: "echo",
                argumentChunks: ['{"value":', '"Brisk tool result"}'],
              },
            ],
            usage: { inputTokens: 18, outputTokens: 12, cost: 0 },
          },
          {
            id: "fake-2",
            text: [
              "The fake provider completed successfully.\n\n",
              "Tool streaming, ordered results, usage, and the follow-up turn are active.",
            ],
            usage: { inputTokens: 30, outputTokens: 19, cost: 0 },
          },
        ]);
        const tools = new ToolRegistry().register<{ readonly value: string }>({
          name: "echo",
          description: "Return a string",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          readOnly: true,
          parallelSafe: true,
          parse(value) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new TypeError("arguments must be an object");
            }
            const record = value as Readonly<
              Record<string, import("./core/messages.ts").JsonValue>
            >;
            const item = record.value;
            if (typeof item !== "string") throw new TypeError("value must be a string");
            return { value: item };
          },
          execute(input) {
            return { content: input.value };
          },
        });
        controller = new AgentUiController(
          new AgentLoop({ provider, tools, model: "fake/brisk-demo" }),
          store,
        );
        store.update({ providerModel: "fake/brisk-demo", status: "ready" });
      },
      async submit(value, store) {
        if (value === "/quit") {
          process.kill(process.pid, "SIGTERM");
          return true;
        }
        if (value === "/clear") {
          store.clearMessages();
          return true;
        }
        if (value === "/help") {
          store.addMessage({
            id: crypto.randomUUID(),
            role: "system",
            content:
              "**Keys:** Enter submits, Shift+Enter or Ctrl+J adds a line, Esc aborts, Ctrl+C exits when idle, Ctrl+P opens models, Ctrl+O opens sessions.\n\n**Commands:** `/help`, `/clear`, `/quit`. Configure a provider or launch with `--fake-provider` for the deterministic harness smoke path.",
          });
          return true;
        }
        if (!controller) {
          store.addMessage({ id: crypto.randomUUID(), role: "user", content: value });
          store.addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "No model is selected. Configure a provider or use `--fake-provider`.",
          });
          return true;
        }
        try {
          if (store.snapshot.busy) await controller.steer(value);
          else await controller.submit(value);
        } catch {
          // the normalized error is already visible through the event stream
        }
        return true;
      },
      abort(store) {
        controller?.cancel();
        if (!controller) store.update({ busy: false, status: "cancelled" });
      },
      openModels(store) {
        store.update({ notice: "Model selector is loading", status: "models" });
      },
      openSessions(store) {
        store.update({ notice: "Session selector is loading", status: "sessions" });
      },
      cleanup() {
        controller?.dispose();
      },
    },
  });
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`brisk: ${message}\n`);
  process.exitCode = 1;
});
