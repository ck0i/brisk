#!/usr/bin/env bun

export {};

const VERSION = "0.1.0";
const startedAt = performance.now();

type PermissionMode = "safe" | "write" | "yolo";

interface EssentialArgs {
  command: "tui" | "bench" | "version" | "help";
  directory: string;
  mode: PermissionMode;
}

function parseEssentialArgs(argv: readonly string[]): EssentialArgs {
  let directory = process.cwd();
  let mode: PermissionMode = "write";
  let command: EssentialArgs["command"] = "tui";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === "bench") command = "bench";
    else if (value === "version" || value === "--version" || value === "-v") command = "version";
    else if (value === "--help" || value === "-h" || value === "help") command = "help";
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

  return { command, directory, mode };
}

function printHelp(): void {
  process.stdout.write(
    `Brisk ${VERSION}\n\nUsage:\n  brisk [directory]\n  brisk bench\n  brisk version\n\nOptions:\n  --permission-mode <safe|write|yolo>\n  -h, --help\n`,
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
  await launchTui({
    workspace: basename(workspace) || workspace,
    mode: args.mode,
    startedAt,
    handlers: {
      async initialize(store) {
        const exists = await Bun.file(workspace).exists();
        if (!exists) throw new Error(`Workspace does not exist: ${workspace}`);
        store.update({ status: "ready" });
      },
      submit(value, store) {
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
              "**Keys:** Enter submits, Shift+Enter or Ctrl+J adds a line, Esc aborts, Ctrl+C exits when idle, Ctrl+P opens models, Ctrl+O opens sessions.\n\nProvider initialization follows in the next milestone.",
          });
          return true;
        }
        store.addMessage({ id: crypto.randomUUID(), role: "user", content: value });
        store.addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "No model is selected. Use `/model` after configuring a provider.",
        });
        return true;
      },
      abort(store) {
        store.update({ busy: false, status: "cancelled" });
      },
      openModels(store) {
        store.update({ notice: "Model selector is loading", status: "models" });
      },
      openSessions(store) {
        store.update({ notice: "Session selector is loading", status: "sessions" });
      },
    },
  });
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`brisk: ${message}\n`);
  process.exitCode = 1;
});
