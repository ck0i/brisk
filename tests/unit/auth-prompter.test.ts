import { describe, expect, test } from "bun:test";

import { browserCommand } from "../../src/cli/auth-prompter.ts";

describe("browserCommand", () => {
  const url = "https://example.invalid/authorize";

  test("uses argument arrays instead of interpolating authorization URLs into a shell", () => {
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", url]);
    expect(browserCommand(url, "darwin")).toEqual(["open", url]);
    expect(browserCommand(url, "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      url,
    ]);
  });

  test("reports unsupported platforms", () => {
    expect(browserCommand(url, "aix")).toBeUndefined();
  });
});
