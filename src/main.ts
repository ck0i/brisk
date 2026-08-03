#!/usr/bin/env bun

export {};

const VERSION = "0.1.0";
const startedAt = performance.now();

interface InteractiveController {
  submit(value: string, tui: import("./app.tsx").TuiRuntime): Promise<boolean>;
  abort(): void;
  openModelPicker(): Promise<void>;
  openSessionPicker(): Promise<void>;
  invokeKeybinding(key: string): Promise<void>;
  close(): Promise<void>;
}

function printHelp(): void {
  process.stdout.write(
    `Brisk ${VERSION}\n\nUsage:\n  brisk [directory]\n  brisk --continue\n  brisk --session <id>\n  brisk auth <login|logout|status> [provider]\n  brisk models\n  brisk sessions\n  brisk doctor [--json]\n  brisk bench [--json]\n  brisk version\n\nOptions:\n  --model <provider/model>\n  --permission-mode <safe|write|yolo>\n  --fake-provider                 deterministic development provider\n  -h, --help\n`,
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
    const { formatBenchmarkReport, runBenchmarks } = await import("./bench/index.ts");
    const report = await runBenchmarks();
    process.stdout.write(
      command.json ? `${JSON.stringify(report)}\n` : formatBenchmarkReport(report),
    );
    return;
  }

  const { resolveConfigPaths } = await import("./config/paths.ts");
  const paths = resolveConfigPaths();
  if (command.name === "auth") {
    const { runAuthCommand } = await import("./cli/provider-commands.ts");
    await runAuthCommand(command, paths);
    return;
  }
  if (command.name === "models") {
    const [{ loadConfig }, { runModelsCommand }] = await Promise.all([
      import("./config/load.ts"),
      import("./cli/provider-commands.ts"),
    ]);
    const loaded = await loadConfig({ paths, workspace: process.cwd() });
    for (const diagnostic of loaded.diagnostics) {
      process.stderr.write(
        `${diagnostic.severity}: ${diagnostic.source} ${diagnostic.path}: ${diagnostic.message}\n`,
      );
    }
    await runModelsCommand(command, paths, loaded.config);
    return;
  }
  if (command.name === "sessions") {
    const { runSessionsCommand } = await import("./cli/session-commands.ts");
    await runSessionsCommand(command, paths);
    return;
  }
  if (command.name === "doctor") {
    const { runDoctorCommand } = await import("./cli/doctor-command.ts");
    await runDoctorCommand(command, paths);
    return;
  }
  const { basename, resolve } = await import("node:path");
  const workspace = resolve(command.directory);
  const { launchTui } = await import("./app.tsx");
  let controller: InteractiveController | undefined;
  await launchTui({
    workspace: basename(workspace) || workspace,
    mode: command.permissionMode ?? "write",
    startedAt,
    handlers: {
      async initialize(store) {
        const { InteractiveRuntime } = await import("./runtime/interactive-runtime.ts");
        controller = await InteractiveRuntime.initialize({ workspace, command }, store);
      },
      async submit(value, store, tui) {
        if (!controller) {
          store.update({ status: "finishing initialization" });
          return false;
        }
        return await controller.submit(value, tui);
      },
      abort(store) {
        controller?.abort();
        if (!controller) store.update({ busy: false, status: "cancelled" });
      },
      openModels(store) {
        if (controller) void controller.openModelPicker();
        else store.update({ status: "models loading" });
      },
      openSessions(store) {
        if (controller) void controller.openSessionPicker();
        else store.update({ status: "sessions loading" });
      },
      keybinding(key, store) {
        if (controller) void controller.invokeKeybinding(key);
        else store.update({ status: "extensions loading" });
      },
      async cleanup() {
        await controller?.close();
      },
    },
  });
}

await main().catch(async (error: unknown) => {
  try {
    const { cleanupToolProcesses } = await import("./tools/process-registry.ts");
    await cleanupToolProcesses();
  } catch {
    // Preserve the primary failure; process cleanup is best effort here.
  }
  const unsafeMessage = error instanceof Error ? error.message : String(error);
  let message = "Unexpected failure";
  try {
    const { redactSecrets } = await import("./providers/secret-redaction.ts");
    message = redactSecrets(unsafeMessage);
  } catch {
    // Never print an unredacted failure when the redactor itself cannot load.
  }
  process.stderr.write(`brisk: ${message}\n`);
  process.exitCode = 1;
});
