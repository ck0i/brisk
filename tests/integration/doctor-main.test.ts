import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("main dispatches doctor --json and maps only error checks to exit 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "brisk-doctor-main-"));
  temporaryDirectories.push(root);
  const secret = "BRISK_TEST_MAIN_DOCTOR_API_KEY";
  const subprocess = Bun.spawn(
    [process.execPath, join(process.cwd(), "src/main.ts"), "doctor", "--json"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENAI_API_KEY: secret,
        TERM: "dumb",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(stdout).not.toContain(secret);
  const parsed: unknown = JSON.parse(stdout);
  expect(isDoctorReport(parsed)).toBe(true);
  if (!isDoctorReport(parsed)) throw new Error("invalid doctor report");
  expect(parsed.checks.some((check) => check.id === "runtime.bun")).toBe(true);
  expect(exitCode).toBe(parsed.status === "error" ? 1 : 0);
});

function isDoctorReport(value: unknown): value is {
  readonly status: "ok" | "warn" | "error";
  readonly checks: readonly { readonly id: string }[];
} {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Readonly<Record<string, unknown>>;
  return (
    (report.status === "ok" || report.status === "warn" || report.status === "error") &&
    Array.isArray(report.checks) &&
    report.checks.every(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        "id" in check &&
        typeof check.id === "string",
    )
  );
}
