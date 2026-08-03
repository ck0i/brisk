import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/tools/artifact-store.ts";
import { limitOutput } from "../../src/tools/output-limiter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("ArtifactStore", () => {
  test("persists private artifacts with stable references and reads them after reopening", async () => {
    const root = await temporaryDirectory();
    const artifactDirectory = join(root, "artifacts");
    const store = new ArtifactStore(artifactDirectory);
    const metadata = await store.write("full output 😀", {
      id: "safe-id_1",
      name: "output.txt",
      mediaType: "text/plain",
    });

    expect(metadata.reference).toBe("artifact://safe-id_1");
    expect(metadata.bytes).toBe(new TextEncoder().encode("full output 😀").byteLength);
    expect(await new ArtifactStore(artifactDirectory).readText(metadata.reference)).toBe(
      "full output 😀",
    );
    expect((await lstat(artifactDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(await store.resolve(metadata.reference))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(artifactDirectory, "safe-id_1.json"))).mode & 0o777).toBe(0o600);
  });

  test("rejects traversal, malformed references, and unknown artifacts", async () => {
    const store = new ArtifactStore(join(await temporaryDirectory(), "artifacts"));
    await store.initialize();

    await expect(store.resolve("artifact://../secret")).rejects.toThrow(
      "Invalid artifact reference",
    );
    await expect(store.resolve("artifact://%2e%2e-secret")).rejects.toThrow(
      "Invalid artifact reference",
    );
    await expect(store.resolve("file://safe-id")).rejects.toThrow("Invalid artifact reference");
    await expect(store.read("artifact://unknown")).rejects.toThrow("Unknown");
  });
});

describe("OutputLimiter", () => {
  test("retains Unicode-safe head and tail and stores exact full output", async () => {
    const store = new ArtifactStore(join(await temporaryDirectory(), "artifacts"));
    const original = "A😀B\nC終D";
    const result = await limitOutput(original, store, { headChars: 2, tailChars: 2 });

    expect(result.truncated).toBe(true);
    expect(result.content.startsWith("A😀\n\n[output truncated:")).toBe(true);
    expect(result.content.endsWith("\n\n終D")).toBe(true);
    expect(result.original).toEqual({ chars: 7, bytes: 12, lines: 2 });
    expect(result.omitted).toEqual({ chars: 3, bytes: 3, lines: 2 });
    expect(result.artifact).toBeDefined();
    expect(await store.readText(result.artifact!.reference)).toBe(original);
  });

  test("returns small output without creating an artifact", async () => {
    const store = new ArtifactStore(join(await temporaryDirectory(), "artifacts"));
    const result = await limitOutput("short", store, { headChars: 4, tailChars: 2 });
    expect(result).toMatchObject({ content: "short", truncated: false });
    expect(result.artifact).toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-artifact-test-"));
  temporaryDirectories.push(path);
  return path;
}
