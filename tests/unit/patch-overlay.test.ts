import { describe, expect, test } from "bun:test";
import { applyPatch, parsePatch } from "diff";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  PatchOverlayWorkspace,
  createPatchOverlayTools,
} from "../../src/subagents/patch-overlay.ts";

const UTF8 = new TextEncoder();

interface Fixture {
  readonly root: string;
  readonly outside: string;
}

describe("PatchOverlayWorkspace", () => {
  test("reads exact Hashline anchors and stages multi-file edits and creates in memory", async () => {
    await withFixture(async ({ root }) => {
      const aPath = path.join(root, "a.txt");
      const bPath = path.join(root, "b.txt");
      await writeFile(aPath, "one\ntwo\n");
      await writeFile(bPath, "alpha\nbeta\n");
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const a = await overlay.read({ path: "a.txt" });
      const b = await overlay.read({ path: "b.txt" });

      expect(a.content).toMatch(/^\[a\.txt#[0-9A-F]{4}\]\n1:one\n2:two\n3:$/);
      await overlay.edit({
        patch: `${a.header}\nPUT 2.=2:\n+TWO\n${b.header}\nPUT 1.=1:\n+ALPHA`,
      });
      await overlay.write({ path: "nested/new.txt", content: "new\n", mode: "create" });

      expect((await overlay.read({ path: "a.txt" })).content).toContain("2:TWO");
      expect((await overlay.read({ path: "nested/new.txt" })).content).toContain("1:new");
      expect(await readFile(aPath, "utf8")).toBe("one\ntwo\n");
      expect(await readFile(bPath, "utf8")).toBe("alpha\nbeta\n");
      expect(await Bun.file(path.join(root, "nested", "new.txt")).exists()).toBe(false);

      const result = await overlay.finalize();
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(result.blocker);
      expect(result.files).toEqual(["a.txt", "b.txt", "nested/new.txt"]);
      expect(result.diff).toContain("--- a.txt");
      expect(result.diff).toContain("+++ nested/new.txt");
      expect(
        applyFinalDiff(
          result.diff,
          new Map([
            ["a.txt", "one\ntwo\n"],
            ["b.txt", "alpha\nbeta\n"],
            ["nested/new.txt", ""],
          ]),
        ),
      ).toEqual(
        new Map([
          ["a.txt", "one\nTWO\n"],
          ["b.txt", "ALPHA\nbeta\n"],
          ["nested/new.txt", "new\n"],
        ]),
      );
      expect(await readFile(aPath, "utf8")).toBe("one\ntwo\n");
      expect(await Bun.file(path.join(root, "nested", "new.txt")).exists()).toBe(false);
    });
  });

  test("stages native Hashline delete and move operations without touching real files", async () => {
    await withFixture(async ({ root }) => {
      const sourcePath = path.join(root, "source.txt");
      const deletedPath = path.join(root, "deleted.txt");
      await writeFile(sourcePath, "source\n");
      await writeFile(deletedPath, "deleted\n");
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const source = await overlay.read({ path: "source.txt" });
      const deleted = await overlay.read({ path: "deleted.txt" });

      await overlay.edit({
        patch: `${source.header}\nMV moved.txt\n${deleted.header}\nREM`,
      });

      expect((await overlay.read({ path: "moved.txt" })).content).toContain("1:source");
      await expect(overlay.read({ path: "source.txt" })).rejects.toThrow("does not exist");
      await expect(overlay.read({ path: "deleted.txt" })).rejects.toThrow("does not exist");
      expect(await readFile(sourcePath, "utf8")).toBe("source\n");
      expect(await readFile(deletedPath, "utf8")).toBe("deleted\n");

      const result = await overlay.finalize();
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(result.blocker);
      expect(result.files).toEqual(["deleted.txt", "moved.txt", "source.txt"]);
      expect(result.diff).toContain("+++ /dev/null");
      expect(result.diff).toContain("--- /dev/null");
      expect(await Bun.file(path.join(root, "moved.txt")).exists()).toBe(false);
    });
  });

  test("enforces seen lines and recovers stale anchors against prior overlay snapshots", async () => {
    await withFixture(async ({ root }) => {
      await writeFile(path.join(root, "partial.txt"), "one\ntwo\nthree\n");
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const partial = await overlay.read({ path: "partial.txt", ranges: [{ start: 1 }] });
      await expect(overlay.edit({ patch: `${partial.header}\nPUT 3.=3:\n+THREE` })).rejects.toThrow(
        "never displayed",
      );

      const whole = await overlay.read({
        path: "partial.txt",
        ranges: [{ start: 1, end: 400 }],
      });
      expect(whole.seenLines).toEqual([1, 2, 3, 4]);
      await overlay.edit({ patch: `${whole.header}\nPUT <1:\n+zero` });
      const recovered = await overlay.edit({ patch: `${whole.header}\nPUT 2.=2:\n+TWO` });
      expect(recovered.files[0]?.warnings.join("\n")).toContain("Recovered");
      expect((await overlay.read({ path: "partial.txt" })).content).toContain(
        "1:zero\n2:one\n3:TWO\n4:three",
      );
      expect(await readFile(path.join(root, "partial.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    });
  });

  test("returns a blocker when a captured real file drifts", async () => {
    await withFixture(async ({ root }) => {
      const filePath = path.join(root, "drift.txt");
      await writeFile(filePath, "old\n");
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const read = await overlay.read({ path: "drift.txt" });
      await overlay.edit({ patch: `${read.header}\nPUT 1.=1:\n+overlay` });
      await writeFile(filePath, "external\n");

      const result = await overlay.finalize();
      expect(result).toEqual({
        status: "blocked",
        blocker: "Real workspace changed after the overlay captured it:\n- drift.txt changed",
        files: [],
      });
      expect("diff" in result).toBe(false);
      expect(await readFile(filePath, "utf8")).toBe("external\n");
    });
  });

  test("jails paths and rejects symlink escapes, binary files, and invalid UTF-8", async () => {
    await withFixture(async ({ root, outside }) => {
      await writeFile(path.join(outside, "secret.txt"), "secret\n");
      await symlink(outside, path.join(root, "escape"));
      await writeFile(path.join(root, "binary.dat"), Uint8Array.from([0x61, 0, 0x62]));
      await writeFile(path.join(root, "invalid.txt"), Uint8Array.from([0xc3, 0x28]));
      const overlay = new PatchOverlayWorkspace({ workspace: root });

      await expect(overlay.read({ path: "../outside/secret.txt" })).rejects.toThrow(
        "escapes the workspace",
      );
      await expect(overlay.read({ path: "escape/secret.txt" })).rejects.toThrow(
        "through a symlink",
      );
      await expect(
        overlay.write({ path: "escape/new.txt", content: "x", mode: "create" }),
      ).rejects.toThrow("through a symlink");
      await expect(overlay.read({ path: "binary.dat" })).rejects.toThrow("NUL/binary");
      await expect(overlay.read({ path: "invalid.txt" })).rejects.toThrow("not valid UTF-8");
    });
  });

  test("preserves UTF-8 BOM and CRLF bytes in edits and final unified patches", async () => {
    await withFixture(async ({ root }) => {
      const filePath = path.join(root, "windows.txt");
      const replacementPath = path.join(root, "replacement.txt");
      const original = Uint8Array.from([0xef, 0xbb, 0xbf, ...UTF8.encode("one\r\ntwo\r\n")]);
      await writeFile(filePath, original);
      await writeFile(replacementPath, original);
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const read = await overlay.read({ path: "windows.txt" });
      expect(read.content).toContain("1:one\n2:two");
      await overlay.edit({ patch: `${read.header}\nPUT 2.=2:\n+TWO` });
      await overlay.write({
        path: "replacement.txt",
        content: "alpha\nbeta\n",
        mode: "replace",
      });

      const result = await overlay.finalize();
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(result.blocker);
      const patches = parsePatch(result.diff);
      const rawOriginal = decodeRaw(original);
      const replaced = applyPatch(rawOriginal, patches[0]!);
      const edited = applyPatch(rawOriginal, patches[1]!);
      expect(replaced).toBe("\uFEFFalpha\r\nbeta\r\n");
      expect(edited).toBe("\uFEFFone\r\nTWO\r\n");
      expect(Uint8Array.from(await readFile(filePath))).toEqual(original);
      expect(Uint8Array.from(await readFile(replacementPath))).toEqual(original);
    });
  });

  test("enforces captured file and byte limits without partially adopting writes", async () => {
    await withFixture(async ({ root }) => {
      await writeFile(path.join(root, "a.txt"), "1234");
      await writeFile(path.join(root, "b.txt"), "b");
      const fileBound = new PatchOverlayWorkspace({ workspace: root, maxCapturedFiles: 1 });
      await fileBound.read({ path: "a.txt" });
      await expect(fileBound.read({ path: "b.txt" })).rejects.toThrow("more than 1 files");
      expect(fileBound.capturedFiles).toBe(1);

      const readBound = new PatchOverlayWorkspace({ workspace: root, maxCapturedBytes: 3 });
      await expect(readBound.read({ path: "a.txt" })).rejects.toThrow("more than 3 bytes");
      expect(readBound.capturedFiles).toBe(0);

      const writeBound = new PatchOverlayWorkspace({ workspace: root, maxCapturedBytes: 4 });
      await writeBound.read({ path: "a.txt" });
      await expect(
        writeBound.write({ path: "a.txt", content: "12345", mode: "replace" }),
      ).rejects.toThrow("more than 4 bytes");
      expect((await writeBound.read({ path: "a.txt" })).content).toContain("1:1234");
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("1234");
    });
  });

  test("discards independently and exposes child-only read/edit/write tools", async () => {
    await withFixture(async ({ root }) => {
      const filePath = path.join(root, "tool.txt");
      await writeFile(filePath, "old\n");
      const overlay = new PatchOverlayWorkspace({ workspace: root });
      const tools = createPatchOverlayTools(overlay);
      expect([tools.read.name, tools.edit.name, tools.write.name]).toEqual([
        "read",
        "edit",
        "write",
      ]);
      expect(tools.read.readOnly).toBe(true);
      expect(tools.edit.readOnly).not.toBe(true);

      const read = await overlay.read({ path: "tool.txt" });
      await overlay.edit({ patch: `${read.header}\nPUT 1.=1:\n+new` });
      overlay.discard();
      overlay.discard();
      expect(overlay.state).toBe("discarded");
      expect(overlay.capturedFiles).toBe(0);
      await expect(overlay.finalize()).rejects.toThrow("discarded");
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    });
  });

  test("emits a final artifact once and returns a stable sorted result", async () => {
    await withFixture(async ({ root }) => {
      await writeFile(path.join(root, "z.txt"), "z\n");
      const emitted: string[] = [];
      const overlay = new PatchOverlayWorkspace({
        workspace: root,
        artifactOutput: async (artifact) => {
          expect(artifact.name).toBe("changes.patch");
          expect(artifact.mediaType).toBe("text/x-diff; charset=utf-8");
          emitted.push(artifact.content);
          return "artifact://patch/1";
        },
      });
      await overlay.write({ path: "a.txt", content: "a\n", mode: "create" });
      const z = await overlay.read({ path: "z.txt" });
      await overlay.edit({ patch: `${z.header}\nPUT 1.=1:\n+Z` });

      const first = await overlay.finalize();
      const second = await overlay.finalize();
      expect(first).toBe(second);
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error(first.blocker);
      expect(first.files).toEqual(["a.txt", "z.txt"]);
      expect(first.artifactReference).toBe("artifact://patch/1");
      expect(emitted).toEqual([first.diff]);
      expect(await readFile(path.join(root, "z.txt"), "utf8")).toBe("z\n");
    });
  });
});

function applyFinalDiff(diff: string, originals: ReadonlyMap<string, string>): Map<string, string> {
  const applied = new Map<string, string>();
  for (const patch of parsePatch(diff)) {
    const resultPath = patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName;
    if (!resultPath) throw new Error("Patch has no result path");
    const sourcePath = patch.oldFileName === "/dev/null" ? resultPath : patch.oldFileName;
    if (!sourcePath) throw new Error("Patch has no source path");
    const result = applyPatch(originals.get(sourcePath) ?? "", patch);
    if (result === false) throw new Error(`Patch did not apply to ${sourcePath}`);
    applied.set(resultPath, result);
  }
  return applied;
}

function decodeRaw(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "brisk-patch-overlay-"));
  const root = path.join(fixtureRoot, "workspace");
  const outside = path.join(fixtureRoot, "outside");
  await mkdir(root);
  await mkdir(outside);
  try {
    await run({ root, outside });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
