import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ArtifactStore } from "../../src/tools/artifact-store.ts";
import { runBash, type BashStreamEvent } from "../../src/tools/bash.ts";
import { ProcessRegistry } from "../../src/tools/process-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("runBash", () => {
  test("streams stdout and stderr separately and reports exit status", async () => {
    const workspace = await temporaryDirectory();
    const events: BashStreamEvent[] = [];
    const result = await runBash(
      workspace,
      artifactStore(workspace),
      { command: "printf stdout; printf stderr >&2; exit 7" },
      { onOutput: (event) => void events.push(event) },
    );

    expect(result.stdout).toBe("stdout");
    expect(result.stderr).toBe("stderr");
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      events
        .filter((event) => event.stream === "stdout")
        .map((event) => event.data)
        .join(""),
    ).toBe("stdout");
    expect(
      events
        .filter((event) => event.stream === "stderr")
        .map((event) => event.data)
        .join(""),
    ).toBe("stderr");
  });

  test("jails cwd and inherits the environment with overrides", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, "child"));
    const result = await runBash(workspace, artifactStore(workspace), {
      command: 'printf \'%s:%s\' "$(basename "$PWD")" "$BRISK_TEST_VALUE"',
      cwd: "child",
      env: { BRISK_TEST_VALUE: "configured" },
    });

    expect(result.stdout).toBe("child:configured");
    await expect(
      runBash(workspace, artifactStore(workspace), { command: "pwd", cwd: ".." }),
    ).rejects.toThrow("escapes workspace");
  });

  test("times out and terminates the whole process group", async () => {
    const workspace = await temporaryDirectory();
    let streamed = "";
    const registry = new ProcessRegistry();
    const result = await runBash(
      workspace,
      artifactStore(workspace),
      { command: "sleep 10 & echo $!; wait", timeoutMs: 500 },
      {
        processRegistry: registry,
        onOutput(event) {
          if (event.stream === "stdout") streamed += event.data;
        },
      },
    );

    const childPid = Number.parseInt(streamed.trim(), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(registry.size).toBe(0);
    expect(processExists(childPid)).toBe(false);
  });

  test("cancellation rejects only after child cleanup", async () => {
    const workspace = await temporaryDirectory();
    const controller = new AbortController();
    const registry = new ProcessRegistry();
    const execution = runBash(
      workspace,
      artifactStore(workspace),
      { command: "sleep 10" },
      { signal: controller.signal, processRegistry: registry },
    );
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 100);

    await expect(execution).rejects.toThrow("cancelled");
    expect(registry.size).toBe(0);
  });

  test("bounds returned output and preserves exact combined output in an artifact", async () => {
    const workspace = await temporaryDirectory();
    const artifacts = artifactStore(workspace);
    const result = await runBash(
      workspace,
      artifacts,
      { command: "printf abcdefghij; printf ERRXYZ >&2" },
      { outputLimit: { headChars: 4, tailChars: 3 } },
    );

    expect(result.truncated).toBe(true);
    expect(result.output).toContain("[output truncated:");
    expect(result.artifact).toBeDefined();
    const full = await artifacts.readText(result.artifact!.reference);
    expect(full).toContain("abcdefghij");
    expect(full).toContain("ERRXYZ");
    expect([...full]).toHaveLength(16);
  });
});

function artifactStore(workspace: string): ArtifactStore {
  return new ArtifactStore(
    join(workspace, `.artifacts-${basename(workspace)}-${crypto.randomUUID()}`),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-bash-test-"));
  temporaryDirectories.push(path);
  return path;
}
