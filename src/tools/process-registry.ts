export interface ManagedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

export class ProcessRegistry {
  private readonly processes = new Set<ManagedProcess>();

  register(process: ManagedProcess): () => void {
    this.processes.add(process);
    let registered = true;
    const unregister = (): void => {
      if (!registered) return;
      registered = false;
      this.processes.delete(process);
    };
    void process.exited.then(unregister, unregister);
    return unregister;
  }

  get size(): number {
    return this.processes.size;
  }

  async terminateAll(graceMs = 150): Promise<void> {
    const processes = [...this.processes];
    await Promise.allSettled(
      processes.map(async (process) => await terminateProcessTree(process, graceMs)),
    );
  }
}

export const toolProcessRegistry = new ProcessRegistry();

export async function cleanupToolProcesses(): Promise<void> {
  await toolProcessRegistry.terminateAll();
}

export function processCleanupHook(
  registry: ProcessRegistry = toolProcessRegistry,
): () => Promise<void> {
  return async (): Promise<void> => await registry.terminateAll();
}

export async function terminateProcessTree(process: ManagedProcess, graceMs = 150): Promise<void> {
  if (process.exitCode !== null) return;
  if (globalThis.process.platform === "win32") {
    await terminateWindowsTree(process);
    return;
  }

  signalPosixTree(process, "SIGTERM");
  const exited = await waitForExit(process, graceMs);
  if (!exited && process.exitCode === null) signalPosixTree(process, "SIGKILL");
  await waitForExit(process, graceMs);
}

function signalPosixTree(process: ManagedProcess, signal: NodeJS.Signals): void {
  try {
    globalThis.process.kill(-process.pid, signal);
  } catch {
    try {
      process.kill(signal);
    } catch {
      // The process may have exited between the checks.
    }
  }
}

async function terminateWindowsTree(process: ManagedProcess): Promise<void> {
  try {
    const killer = Bun.spawn(["taskkill", "/pid", String(process.pid), "/t", "/f"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await killer.exited;
  } catch {
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
  await waitForExit(process, 250);
}

async function waitForExit(process: ManagedProcess, milliseconds: number): Promise<boolean> {
  if (process.exitCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
