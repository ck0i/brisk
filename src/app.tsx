import { CliRenderEvents, createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";

import { Root } from "./ui/root.tsx";
import { UiStore, type UiSnapshot } from "./ui/state.ts";

export interface TuiRuntime {
  runSuspended<T>(operation: () => Promise<T>): Promise<T>;
  exit(): void;
}

export interface TuiHandlers {
  initialize?: (store: UiStore, runtime: TuiRuntime) => void | Promise<void>;
  submit: (value: string, store: UiStore, runtime: TuiRuntime) => boolean | Promise<boolean>;
  abort?: (store: UiStore) => void;
  openModels?: (store: UiStore) => void;
  openSessions?: (store: UiStore) => void;
  openPath?: (path: string, store: UiStore, runtime: TuiRuntime) => void;
  keybinding?: (key: string, store: UiStore) => void;
  cleanup?: () => void | Promise<void>;
}

export interface LaunchTuiOptions {
  workspace: string;
  mode?: UiSnapshot["mode"];
  startedAt: number;
  handlers: TuiHandlers;
}

export interface LaunchResult {
  timeToFirstDrawMs: number;
}

const TERMINAL_RECOVERY_SEQUENCE = "\u001b[?2026l\u001b[?25h\u001b[0m";

function recoverStaleTerminalState(): void {
  if (process.stdout.isTTY) process.stdout.write(TERMINAL_RECOVERY_SEQUENCE);
}

function onceFrame(renderer: CliRenderer): Promise<void> {
  return new Promise((resolve) => renderer.once(CliRenderEvents.FRAME, () => resolve()));
}

export async function launchTui(options: LaunchTuiOptions): Promise<LaunchResult> {
  // A prior TUI killed during synchronized output can leave the terminal buffering every frame.
  recoverStaleTerminalState();
  const renderer = await createCliRenderer({
    targetFps: 60,
    maxFps: 60,
    exitOnCtrlC: false,
    autoFocus: false,
    clearOnShutdown: true,
    openConsoleOnError: false,
  });
  const store = new UiStore(options.workspace, options.mode);
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const exit = (): void => resolveExit?.();
  const runtime: TuiRuntime = {
    async runSuspended<T>(operation: () => Promise<T>): Promise<T> {
      renderer.suspend();
      try {
        return await operation();
      } finally {
        renderer.resume();
        renderer.requestRender();
      }
    },
    exit,
  };
  const firstFrame = onceFrame(renderer);

  const onSignal = (): void => {
    if (store.snapshot.busy) options.handlers.abort?.(store);
    else exit();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.once(CliRenderEvents.DESTROY, exit);
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: { error: Error }) => {
    store.update({ status: "render error", notice: error.message });
    exit();
  });

  try {
    await render(
      () => (
        <Root
          store={store}
          onSubmit={(value) => options.handlers.submit(value, store, runtime)}
          onAbort={() => options.handlers.abort?.(store)}
          onExit={exit}
          onOpenModels={() => options.handlers.openModels?.(store)}
          onOpenSessions={() => options.handlers.openSessions?.(store)}
          onOpenPath={(path) => options.handlers.openPath?.(path, store, runtime)}
          onKeybinding={(key) => options.handlers.keybinding?.(key, store)}
          renderer={renderer}
        />
      ),
      renderer,
    );
    await firstFrame;
    const timeToFirstDrawMs = performance.now() - options.startedAt;

    queueMicrotask(() => {
      void Promise.resolve(options.handlers.initialize?.(store, runtime)).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          store.update({ status: "initialization failed", notice: message });
        },
      );
    });

    await exited;
    return { timeToFirstDrawMs };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await options.handlers.cleanup?.();
    } finally {
      renderer.destroy();
    }
  }
}
