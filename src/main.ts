#!/usr/bin/env bun

export {};

const VERSION = "0.1.0";
const startedAt = performance.now();

type PermissionMode = "safe" | "write" | "yolo";

interface EssentialArgs {
  command: "tui" | "bench" | "version" | "help";
  directory: string;
  mode: PermissionMode;
  fakeProvider: boolean;
}

interface RuntimeController {
  submit(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  cancel(): void;
  dispose(): void;
}

function parseEssentialArgs(argv: readonly string[]): EssentialArgs {
  let directory = process.cwd();
  let mode: PermissionMode = "write";
  let command: EssentialArgs["command"] = "tui";
  let fakeProvider = process.env.BRISK_FAKE_PROVIDER === "1";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === "bench") command = "bench";
    else if (value === "version" || value === "--version" || value === "-v") command = "version";
    else if (value === "--help" || value === "-h" || value === "help") command = "help";
    else if (value === "--fake-provider") fakeProvider = true;
    else if (value === "--permission-mode") {
      const next = argv[index + 1];
      if (next !== "safe" && next !== "write" && next !== "yolo") {
        throw new Error("--permission-mode must be safe, write, or yolo");
      }
      mode = next;
      index += 1;
    } else if (!value.startsWith("-")) {
      directory = value;
    }
  }

  return { command, directory, mode, fakeProvider };
}

function printHelp(): void {
  process.stdout.write(
    `Brisk ${VERSION}\n\nUsage:\n  brisk [directory]\n  brisk bench\n  brisk version\n\nOptions:\n  --permission-mode <safe|write|yolo>\n  --fake-provider                 deterministic development provider\n  -h, --help\n`,
  );
}

async function main(): Promise<void> {
  const args = parseEssentialArgs(process.argv.slice(2));
  if (args.command === "version") {
    process.stdout.write(`brisk ${VERSION}\n`);
    return;
  }
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "bench") {
    const { benchmarkFirstDraw } = await import("./ui/benchmark.tsx");
    const value = await benchmarkFirstDraw();
    process.stdout.write(`Time to first draw (headless): ${value.toFixed(2)} ms\n`);
    return;
  }

  const { basename, resolve } = await import("node:path");
  const workspace = resolve(args.directory);
  const { launchTui } = await import("./app.tsx");
  let controller: RuntimeController | undefined;
  await launchTui({
    workspace: basename(workspace) || workspace,
    mode: args.mode,
    startedAt,
    handlers: {
      async initialize(store) {
        const { stat } = await import("node:fs/promises");
        const workspaceStat = await stat(workspace).catch(() => undefined);
        if (!workspaceStat?.isDirectory())
          throw new Error(`Workspace does not exist: ${workspace}`);
        if (!args.fakeProvider) {
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
