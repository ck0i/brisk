import { describe, expect, test } from "bun:test";

import { fileEditorCommand } from "../../src/runtime/file-opener.ts";

describe("file editor command", () => {
  test("prefers Brisk, visual, and standard editor settings", () => {
    const brisk = fileEditorCommand("/tmp/file with spaces.ts", {
      platform: "linux",
      environment: { BRISK_EDITOR: "code --wait", VISUAL: "nvim", EDITOR: "vi" },
    });
    expect(brisk.command).toEqual(["/bin/sh", "-lc", 'exec code --wait "$BRISK_OPEN_PATH"']);
    expect(brisk.environment.BRISK_OPEN_PATH).toBe("/tmp/file with spaces.ts");

    expect(
      fileEditorCommand("/tmp/file.ts", {
        platform: "linux",
        environment: { VISUAL: "nvim", EDITOR: "vi" },
      }).command,
    ).toEqual(["/bin/sh", "-lc", 'exec nvim "$BRISK_OPEN_PATH"']);
  });

  test("uses platform file openers when no editor is configured", () => {
    expect(
      fileEditorCommand("/tmp/file.ts", { platform: "linux", environment: {} }).command,
    ).toEqual(["xdg-open", "/tmp/file.ts"]);
    expect(
      fileEditorCommand("/tmp/file.ts", { platform: "darwin", environment: {} }).command,
    ).toEqual(["open", "/tmp/file.ts"]);
  });
});
