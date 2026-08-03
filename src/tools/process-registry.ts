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

  if (globalThis.process.platform === "linux") {
    await terminateLinuxDescendants(process.pid, graceMs);
  }
  signalPosixTree(process, "SIGTERM");
  const exited = await waitForExit(process, graceMs);
  if (!exited && process.exitCode === null) signalPosixTree(process, "SIGKILL");
  await waitForExit(process, graceMs);
}

async function terminateLinuxDescendants(rootPid: number, graceMs: number): Promise<void> {
  const descendants = await collectLinuxDescendants(rootPid);
  if (descendants.length === 0) return;
  signalPids(descendants, "SIGTERM");
  if (await waitForPidsGone(descendants, graceMs)) return;
  signalPids(descendants, "SIGKILL");
  await waitForPidsGone(descendants, graceMs);
}

async function collectLinuxDescendants(rootPid: number): Promise<number[]> {
  const ordered: number[] = [];
  const visited = new Set<number>();
  const visit = async (pid: number): Promise<void> => {
    if (visited.has(pid)) return;
    visited.add(pid);
    let children = "";
    try {
      children = await Bun.file(`/proc/${pid}/task/${pid}/children`).text();
    } catch {
      return;
    }
    for (const value of children.trim().split(/\s+/)) {
      if (value.length === 0) continue;
      const childPid = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(childPid) || childPid <= 0) continue;
      await visit(childPid);
      ordered.push(childPid);
    }
  };
  await visit(rootPid);
  return ordered;
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      globalThis.process.kill(pid, signal);
    } catch {
      // The process may have exited between discovery and signaling.
    }
  }
}

async function waitForPidsGone(pids: readonly number[], milliseconds: number): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  do {
    if (pids.every((pid) => !pidExists(pid))) return true;
    await Bun.sleep(5);
  } while (performance.now() < deadline);
  return pids.every((pid) => !pidExists(pid));
}

function pidExists(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
