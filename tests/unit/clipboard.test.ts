import { describe, expect, test } from "bun:test";

import { clipboardCommand } from "../../src/ui/clipboard.ts";

describe("system clipboard fallback", () => {
  test("selects Wayland, X11, macOS, and Windows clipboard helpers", () => {
    const available = (commands: readonly string[]) => (command: string) =>
      commands.includes(command) ? `/bin/${command}` : null;

    expect(clipboardCommand({ platform: "linux", which: available(["wl-copy"]) })).toEqual([
      "/bin/wl-copy",
    ]);
    expect(clipboardCommand({ platform: "linux", which: available(["xclip"]) })).toEqual([
      "/bin/xclip",
      "-selection",
      "clipboard",
    ]);
    expect(clipboardCommand({ platform: "linux", which: available(["xsel"]) })).toEqual([
      "/bin/xsel",
      "--clipboard",
      "--input",
    ]);
    expect(clipboardCommand({ platform: "darwin", which: available(["pbcopy"]) })).toEqual([
      "pbcopy",
    ]);
    expect(clipboardCommand({ platform: "win32", which: available(["clip.exe"]) })).toEqual([
      "/bin/clip.exe",
    ]);
  });

  test("reports no fallback when the platform has no clipboard helper", () => {
    expect(clipboardCommand({ platform: "linux", which: () => null })).toBeUndefined();
  });
});
