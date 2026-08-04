import { describe, expect, test } from "bun:test";
import { computeFileHash } from "@oh-my-pi/hashline";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { HashlineWorkspace, type WorkspaceMutationIO } from "../../src/tools/hashline-workspace.ts";

describe("HashlineWorkspace read", () => {
  test("returns the exact upstream header and numbered lines", async () => {
    await withWorkspace(async ({ root, service }) => {
      await writeFile(path.join(root, "sample.txt"), "one\ntwo\n");

      const result = await service.read({ path: "sample.txt" });
      const tag = computeFileHash("one\ntwo\n");
      expect(result.header).toBe(`[sample.txt#${tag}]`);
      expect(result.content).toBe(`[sample.txt#${tag}]\n1:one\n2:two\n3:`);
      expect(result.seenLines).toEqual([1, 2, 3]);
    });
  });

  test("strips a UTF-8 BOM, normalizes CRLF, and records only ranged lines", async () => {
    await withWorkspace(async ({ root, service }) => {
      await writeFile(
        path.join(root, "windows.txt"),
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\ntwo\r\nthree")]),
      );

      const result = await service.read({
        path: "windows.txt",
        ranges: [{ start: 1 }, { start: 3 }],
      });
      const tag = computeFileHash("one\ntwo\nthree");
      expect(result.content).toBe(`[windows.txt#${tag}]\n1:one\n...\n3:three`);
      expect(service.snapshots.byHash(result.canonicalPath, tag)?.seenLines).toEqual(
        new Set([1, 3]),
      );
    });
  });

  test("rejects NUL/binary bytes, invalid UTF-8, and out-of-range reads", async () => {
    await withWorkspace(async ({ root, service }) => {
      await writeFile(path.join(root, "binary.dat"), Uint8Array.from([0x61, 0, 0x62]));
      await writeFile(path.join(root, "invalid.txt"), Uint8Array.from([0xc3, 0x28]));
      await writeFile(path.join(root, "short.txt"), "one\ntwo");

      await expect(service.read({ path: "binary.dat" })).rejects.toThrow("NUL/binary");
      await expect(service.read({ path: "invalid.txt" })).rejects.toThrow("not valid UTF-8");
      const clamped = await service.read({
        path: "short.txt",
        ranges: [{ start: 1, end: 400 }],
      });
      expect(clamped.content).toEndWith("1:one\n2:two");
      expect(clamped.seenLines).toEqual([1, 2]);
      await expect(
        service.read({ path: "short.txt", ranges: [{ start: 3, end: 4 }] }),
      ).rejects.toThrow("has 2 lines");
      await writeFile(path.join(root, "limited.txt"), "one\ntwo");
      await expect(service.read({ path: "limited.txt", maxOutputBytes: 5 })).rejects.toThrow(
        "maximum is 5",
      );
      expect(
        service.snapshots.head(service.paths.resolveRead("limited.txt").canonicalPath),
      ).toBeNull();
    });
  });

  test("reads authored absolute paths, rejects relative symlink escapes, and supports artifacts", async () => {
    await withWorkspace(async ({ root, outside }) => {
      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "secret");
      await symlink(outside, path.join(root, "escape"));
      const service = new HashlineWorkspace({
        workspace: root,
        artifactReader: { read: async () => new TextEncoder().encode("artifact\n") },
      });

      await expect(service.read({ path: "escape/secret.txt" })).rejects.toThrow(
        "through a symlink",
      );
      expect((await service.read({ path: outsideFile })).content).toContain("1:secret");
      expect((await service.read({ path: "artifact://result/1" })).header).toMatch(
        /^\[artifact:\/\/result\/1#[0-9A-F]{4}\]$/,
      );
    });
  });
});

describe("HashlineWorkspace edit", () => {
  test("previews a standard unified diff before committing a successful edit", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "edit.txt");
      await writeFile(filePath, "one\ntwo\nthree\n");
      const read = await service.read({ path: "edit.txt" });

      const pending = await service.edit({
        patch: `${read.header}\nPUT 2.=2:\n+TWO`,
      });
      expect(pending.preview.diff).toContain("Index: edit.txt");
      expect(pending.preview.diff).toContain("@@ -1,3 +1,3 @@");
      expect(pending.preview.diff).toContain("-two");
      expect(pending.preview.diff).toContain("+TWO");
      expect(await readFile(filePath, "utf8")).toBe("one\ntwo\nthree\n");

      const result = await pending.commit();
      expect(result.committed).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("one\nTWO\nthree\n");
    });
  });

  test("separates distant edits into hunks with one context line", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "distant.txt");
      const lines = Array.from({ length: 310 }, (_, index) => `line ${index + 1}`);
      await writeFile(filePath, `${lines.join("\n")}\n`);
      const read = await service.read({ path: "distant.txt" });

      const pending = await service.edit({
        patch: `${read.header}\nPUT 40.=40:\n+changed 40\nPUT 305.=305:\n+changed 305`,
      });
      const hunks = pending.preview.diff.split("\n").filter((line) => line.startsWith("@@"));

      expect(hunks).toEqual(["@@ -39,3 +39,3 @@", "@@ -304,3 +304,3 @@"]);
      expect(pending.preview.diff).toContain(" line 41\n@@ -304");
      expect(pending.preview.diff).toContain("@@ -304,3 +304,3 @@\n line 304");
    });
  });

  test("preserves BOM, CRLF, and the final newline through Patcher", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "windows.txt");
      await writeFile(
        filePath,
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\ntwo\r\n")]),
      );
      const read = await service.read({ path: "windows.txt" });
      const pending = await service.edit({ patch: `${read.header}\nPUT 2.=2:\n+TWO` });
      await pending.commit();

      expect(Uint8Array.from(await readFile(filePath))).toEqual(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\nTWO\r\n")]),
      );
    });
  });

  test("recovers a stale edit when its anchor is unchanged and rejects changed anchors", async () => {
    await withWorkspace(async ({ root, service }) => {
      const safePath = path.join(root, "safe.txt");
      await writeFile(safePath, "one\ntwo\nthree\n");
      const safeRead = await service.read({ path: "safe.txt" });
      await writeFile(safePath, "zero\none\ntwo\nthree\n");
      const recovered = await service.edit({
        patch: `${safeRead.header}\nPUT 2.=2:\n+TWO`,
      });
      expect(recovered.preview.files[0]?.warnings.join("\n")).toContain("Recovered");
      await recovered.commit();
      expect(await readFile(safePath, "utf8")).toBe("zero\none\nTWO\nthree\n");

      const rejectedPath = path.join(root, "rejected.txt");
      await writeFile(rejectedPath, "one\ntwo\nthree\n");
      const rejectedRead = await service.read({ path: "rejected.txt" });
      await writeFile(rejectedPath, "one\nexternally changed\nthree\n");
      await expect(
        service.edit({ patch: `${rejectedRead.header}\nPUT 2.=2:\n+TWO` }),
      ).rejects.toThrow("file changed between read and edit");
      expect(await readFile(rejectedPath, "utf8")).toBe("one\nexternally changed\nthree\n");
    });
  });

  test("enforces partial-read seen lines", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "partial.txt");
      await writeFile(filePath, "one\ntwo\nthree\n");
      const read = await service.read({ path: "partial.txt", ranges: [{ start: 1 }] });

      await expect(service.edit({ patch: `${read.header}\nPUT 3.=3:\n+THREE` })).rejects.toThrow(
        "never displayed",
      );
      expect(await readFile(filePath, "utf8")).toBe("one\ntwo\nthree\n");
    });
  });

  test("rejects a file changed after preview without overwriting it", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "race.txt");
      await writeFile(filePath, "old\n");
      const read = await service.read({ path: "race.txt" });
      const pending = await service.edit({ patch: `${read.header}\nPUT 1.=1:\n+new` });

      await writeFile(filePath, "external\n");
      await expect(pending.commit()).rejects.toThrow("changed between preview and commit");
      expect(await readFile(filePath, "utf8")).toBe("external\n");
    });
  });

  test("commits a multi-file patch atomically", async () => {
    await withWorkspace(async ({ root, service }) => {
      await writeFile(path.join(root, "a.txt"), "a\n");
      await writeFile(path.join(root, "b.txt"), "b\n");
      const a = await service.read({ path: "a.txt" });
      const b = await service.read({ path: "b.txt" });
      const pending = await service.edit({
        patch: `${a.header}\nPUT 1.=1:\n+A\n${b.header}\nPUT 1.=1:\n+B`,
      });

      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a\n");
      expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("b\n");
      await pending.commit();
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("A\n");
      expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("B\n");
    });
  });

  test("buffers move and delete operations until commit", async () => {
    await withWorkspace(async ({ root, service }) => {
      const sourcePath = path.join(root, "source.txt");
      const deletedPath = path.join(root, "deleted.txt");
      await writeFile(sourcePath, "source\n");
      await writeFile(deletedPath, "deleted\n");
      const source = await service.read({ path: "source.txt" });
      const deleted = await service.read({ path: "deleted.txt" });

      const move = await service.edit({ patch: `${source.header}\nMV moved.txt` });
      expect(await Bun.file(sourcePath).exists()).toBe(true);
      expect(await Bun.file(path.join(root, "moved.txt")).exists()).toBe(false);
      await move.commit();
      expect(await Bun.file(sourcePath).exists()).toBe(false);
      expect(await readFile(path.join(root, "moved.txt"), "utf8")).toBe("source\n");

      const deletion = await service.edit({ patch: `${deleted.header}\nREM` });
      expect(await Bun.file(deletedPath).exists()).toBe(true);
      await deletion.commit();
      expect(await Bun.file(deletedPath).exists()).toBe(false);
    });
  });

  test("rolls back every original byte after an injected second-write failure", async () => {
    await withWorkspace(async ({ root }) => {
      const originalA = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\n")]);
      const originalB = new TextEncoder().encode("b\n");
      await writeFile(path.join(root, "a.txt"), originalA);
      await writeFile(path.join(root, "b.txt"), originalB);
      const mutationIO = new FailSecondWriteIO();
      const service = new HashlineWorkspace({ workspace: root, mutationIO });
      const a = await service.read({ path: "a.txt" });
      const b = await service.read({ path: "b.txt" });
      const pending = await service.edit({
        patch: `${a.header}\nPUT 1.=1:\n+A\n${b.header}\nPUT 1.=1:\n+B`,
      });

      await expect(pending.commit()).rejects.toThrow("injected second-write failure");
      expect(Uint8Array.from(await readFile(path.join(root, "a.txt")))).toEqual(originalA);
      expect(Uint8Array.from(await readFile(path.join(root, "b.txt")))).toEqual(originalB);
    });
  });

  test("surfaces compact native parse diagnostics and rejects relative traversal", async () => {
    await withWorkspace(async ({ root, service }) => {
      await writeFile(path.join(root, "a.txt"), "a\n");
      await expect(service.edit({ patch: "[a.txt#BAD]\nPUT 1.=1:\n+A" })).rejects.toThrow(
        "Invalid Hashline patch: Input header must be",
      );
      await expect(
        service.edit({ patch: "[../outside/x.txt#1234]\nPUT 1.=1:\n+x" }),
      ).rejects.toThrow("escapes the workspace");
    });
  });
});

describe("HashlineWorkspace write", () => {
  test("requires explicit create/replace modes and preserves BOM plus dominant newline", async () => {
    await withWorkspace(async ({ root, service }) => {
      const filePath = path.join(root, "windows.txt");
      const original = Uint8Array.from([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode("one\r\ntwo\r\nthree\n"),
      ]);
      await writeFile(filePath, original);
      await expect(
        service.write({ path: "windows.txt", content: "x\n", mode: "create" }),
      ).rejects.toThrow("already exists");

      const pending = await service.write({
        path: "windows.txt",
        content: "alpha\nbeta\n",
        mode: "replace",
      });
      expect(await readFile(filePath)).toEqual(Buffer.from(original));
      await pending.commit();
      expect(Uint8Array.from(await readFile(filePath))).toEqual(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("alpha\r\nbeta\r\n")]),
      );
    });
  });

  test("writes authored absolute paths outside the workspace", async () => {
    await withWorkspace(async ({ outside, service }) => {
      const target = path.join(outside, "absolute.txt");
      const pending = await service.write({
        path: target,
        content: "outside\n",
        mode: "create",
      });

      expect(await Bun.file(target).exists()).toBe(false);
      expect(pending.preview.files[0]?.path).toBe(target);
      await pending.commit();
      expect(await readFile(target, "utf8")).toBe("outside\n");
    });
  });

  test("creates parent directories only on commit and supports discard", async () => {
    await withWorkspace(async ({ root, service }) => {
      const pending = await service.write({
        path: "nested/new.txt",
        content: "new\n",
        mode: "create",
      });
      expect(await Bun.file(path.join(root, "nested", "new.txt")).exists()).toBe(false);
      pending.discard();
      expect(await Bun.file(path.join(root, "nested")).exists()).toBe(false);

      const committed = await service.write({
        path: "nested/new.txt",
        content: "new\n",
        mode: "create",
      });
      await committed.commit();
      expect(await readFile(path.join(root, "nested", "new.txt"), "utf8")).toBe("new\n");
    });
  });
});

class FailSecondWriteIO implements WorkspaceMutationIO {
  #writeCount = 0;
  #failed = false;

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.#writeCount += 1;
    if (this.#writeCount === 2 && !this.#failed) {
      this.#failed = true;
      throw new Error("injected second-write failure");
    }
    await writeFile(filePath, bytes);
  }

  async removeFile(filePath: string): Promise<void> {
    await rm(filePath);
  }
}

async function withWorkspace(
  run: (fixture: { root: string; outside: string; service: HashlineWorkspace }) => Promise<void>,
): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "brisk-hashline-"));
  const root = path.join(fixtureRoot, "workspace");
  const outside = path.join(fixtureRoot, "outside");
  await mkdir(root);
  await mkdir(outside);
  const service = new HashlineWorkspace({ workspace: root });
  try {
    await run({ root, outside, service });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
