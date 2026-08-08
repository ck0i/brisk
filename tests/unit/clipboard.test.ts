import { describe, expect, test } from "bun:test";

import {
  clipboardCommand,
  clipboardReadCommand,
  readSystemClipboard,
} from "../../src/ui/clipboard.ts";

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
    expect(clipboardReadCommand({ platform: "linux", which: available(["wl-paste"]) })).toEqual([
      "/bin/wl-paste",
      "--no-newline",
    ]);
    expect(clipboardReadCommand({ platform: "linux", which: available(["xclip"]) })).toEqual([
      "/bin/xclip",
      "-selection",
      "clipboard",
      "-o",
    ]);
    expect(clipboardReadCommand({ platform: "darwin", which: available(["pbpaste"]) })).toEqual([
      "pbpaste",
    ]);
  });

  test("reports no fallback when the platform has no clipboard helper", () => {
    expect(clipboardCommand({ platform: "linux", which: () => null })).toBeUndefined();
  });

  test("prefers clipboard images and encodes them for provider messages", async () => {
    const paste = await readSystemClipboard({
      platform: "linux",
      which: () => null,
      readImage: async () => ({
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mimeType: "IMAGE/PNG",
      }),
    });

    expect(paste).toEqual({
      type: "image",
      data: "iVBORw==",
      mimeType: "image/png",
    });
  });

  test("falls back to clipboard text when there is no image", async () => {
    const commands: readonly string[][] = [];
    const paste = await readSystemClipboard({
      platform: "linux",
      which: (command) => (command === "wl-paste" ? "/bin/wl-paste" : null),
      readImage: async () => undefined,
      run: async (command) => {
        (commands as string[][]).push([...command]);
        return new TextEncoder().encode("clipboard text");
      },
    });

    expect(commands).toEqual([["/bin/wl-paste", "--no-newline"]]);
    expect(paste).toEqual({ type: "text", text: "clipboard text" });
  });
});
