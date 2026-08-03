import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

import {
  runDoctorCommand,
  type DoctorCommandOptions,
  type DoctorDependencies,
} from "../../src/cli/doctor-command.ts";
import { resolveConfigPaths, type ConfigPaths } from "../../src/config/paths.ts";

const temporaryDirectories: string[] = [];
const secret = "BRISK_TEST_DOCTOR_SECRET_7f551d";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runDoctorCommand", () => {
  test("emits a deterministic JSON report with the complete check shape", async () => {
    const { root, paths } = await createLayout();
    await writeValidModelCache(paths.modelCachePath, secret);
    await writeValidSessionIndex(paths);
    const dependencies = healthyDependencies();

    const first = captureOutput();
    const firstReport = await runDoctorCommand(
      { name: "doctor", json: true },
      paths,
      options(first.output, dependencies),
    );
    const second = captureOutput();
    const secondReport = await runDoctorCommand(
      { name: "doctor", json: true },
      paths,
      options(second.output, dependencies),
    );

    expect(firstReport.status).toBe("ok");
    expect(firstReport).toEqual(secondReport);
    expect(first.text()).toBe(second.text());
    expect(JSON.parse(first.text())).toEqual(firstReport);
    expect(first.text()).not.toContain(secret);
    expect(firstReport.checks.map((check) => check.id)).toEqual([
      "runtime.bun",
      "ui.opentui",
      "directory.config",
      "directory.data",
      "directory.cache",
      "auth.providers",
      "models.cache",
      "tool.rg",
      "tool.git",
      "terminal.capabilities",
      "sessions.index",
      "extensions.errors",
    ]);
    for (const check of firstReport.checks) {
      expect(Object.keys(check)).toEqual(["id", "status", "message", "fix", "details"]);
    }
    expect(firstReport.checks.find((check) => check.id === "auth.providers")?.details).toEqual({
      inspected: true,
      providerCount: 2,
      configuredCount: 1,
      oauthAvailableCount: 1,
    });
    expect(firstReport.checks.find((check) => check.id === "models.cache")?.details).toEqual({
      exists: true,
      valid: true,
      modelCount: 1,
    });

    for (const directory of [paths.configRoot, paths.dataRoot, paths.cacheRoot]) {
      const entries = await readdir(directory);
      expect(entries.some((entry) => entry.startsWith(".brisk-doctor-"))).toBe(false);
    }
    expect(root.length).toBeGreaterThan(0);
  });

  test("redacts dependency failures, credential-adjacent data, and extension error contents", async () => {
    const { paths } = await createLayout();
    await mkdir(dirname(paths.modelCachePath), { recursive: true });
    await writeFile(paths.modelCachePath, `{"version":1,"models":["${secret}"]}`);
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, "errors.json"),
      JSON.stringify({ errors: [{ extension: "fixture", message: secret }] }),
    );
    const exitCodes: number[] = [];
    const capture = captureOutput();

    const report = await runDoctorCommand({ name: "doctor", json: true }, paths, {
      output: capture.output,
      setExitCode(exitCode) {
        exitCodes.push(exitCode);
      },
      dependencies: {
        runtimeVersion: secret,
        async loadOpenTui() {
          throw new Error(secret);
        },
        async createAuthService() {
          throw new Error(`credential=${secret}`);
        },
        async probeVersion() {
          return { available: true, version: secret };
        },
        terminal: {
          stdinTty: true,
          stdoutTty: true,
          stderrTty: true,
          term: secret,
          colorTerm: secret,
          noColor: false,
          forceColor: false,
          colorDepth: 24,
        },
        async inspectSessionIndex() {
          throw new Error(secret);
        },
      },
    });

    expect(report.status).toBe("error");
    expect(exitCodes).toEqual([1]);
    expect(capture.text()).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.checks.find((check) => check.id === "extensions.errors")).toMatchObject({
      status: "warn",
      details: { reportPresent: true, valid: true, errorCount: 1 },
    });
  });

  test("warning-only diagnostics produce stable human output without setting failure", async () => {
    const { paths } = await createLayout();
    const dependencies: DoctorDependencies = {
      runtimeVersion: "1.3.14",
      loadOpenTui: async () => ({ createCliRenderer() {} }),
      createAuthService: async () => ({
        listProviderStatus: () => [],
        close() {},
      }),
      probeVersion: async () => ({ available: false, version: null }),
      terminal: {
        stdinTty: false,
        stdoutTty: false,
        stderrTty: false,
        term: null,
        colorTerm: null,
        noColor: true,
        forceColor: false,
        colorDepth: 1,
      },
      inspectSessionIndex: async () => ({
        source: "rebuild",
        sessionCount: 0,
        diagnosticCount: 0,
      }),
    };
    const exitCodes: number[] = [];
    const first = captureOutput();
    const firstReport = await runDoctorCommand(
      { name: "doctor", json: false },
      paths,
      options(first.output, dependencies, exitCodes),
    );
    const second = captureOutput();
    const secondReport = await runDoctorCommand(
      { name: "doctor", json: false },
      paths,
      options(second.output, dependencies, exitCodes),
    );

    expect(firstReport.status).toBe("warn");
    expect(firstReport).toEqual(secondReport);
    expect(first.text()).toBe(second.text());
    expect(first.text()).toContain("Overall: WARN");
    expect(exitCodes).toEqual([]);
  });
});

function healthyDependencies(): DoctorDependencies {
  return {
    runtimeVersion: "1.3.14",
    loadOpenTui: async () => ({ createCliRenderer() {} }),
    createAuthService: async () => ({
      listProviderStatus: () => [
        { configured: true, oauthAvailable: true },
        { configured: false, oauthAvailable: false },
      ],
      close() {},
    }),
    probeVersion: async (executable) => ({
      available: true,
      version: executable === "rg" ? "14.1.0" : "2.43.0",
    }),
    terminal: {
      stdinTty: true,
      stdoutTty: true,
      stderrTty: true,
      term: "xterm-256color",
      colorTerm: "truecolor",
      noColor: false,
      forceColor: false,
      colorDepth: 24,
    },
  };
}

function options(
  output: Writable,
  dependencies: DoctorDependencies,
  exitCodes: number[] = [],
): DoctorCommandOptions {
  return {
    output,
    dependencies,
    setExitCode(exitCode) {
      exitCodes.push(exitCode);
    },
  };
}

function captureOutput(): { readonly output: Writable; readonly text: () => string } {
  let value = "";
  return {
    output: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

async function createLayout(): Promise<{ root: string; paths: ConfigPaths }> {
  const root = await mkdtemp(join(tmpdir(), "brisk-doctor-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    paths: resolveConfigPaths({ platform: "linux", homeDir: root, env: {} }),
  };
}

async function writeValidModelCache(cachePath: string, extraValue: string): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      version: 1,
      models: [
        {
          provider: "fixture",
          id: "fixture-model",
          name: "Fixture model",
          api: "openai-completions",
          baseUrl: "https://fixture.test/v1",
          contextWindow: 8192,
          maxTokens: 1024,
          input: ["text"],
          reasoning: false,
          supportsTools: true,
          available: true,
          source: "custom",
          ignoredCredentialLikeField: extraValue,
        },
      ],
    }),
  );
}

async function writeValidSessionIndex(paths: ConfigPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.sessionsDir, { recursive: true }),
    mkdir(dirname(paths.sessionIndexPath), { recursive: true }),
  ]);
  await writeFile(
    paths.sessionIndexPath,
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessions: [],
    })}\n`,
  );
}
