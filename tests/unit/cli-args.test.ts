import { describe, expect, test } from "bun:test";

import { CliArgumentError, parseCliArgs } from "../../src/cli/args.ts";

describe("parseCliArgs", () => {
  test("parses the complete TUI surface without filesystem work", () => {
    expect(
      parseCliArgs(
        [
          "/tmp/project",
          "--session",
          "session-1",
          "--model",
          "anthropic/example",
          "--permission-mode",
          "safe",
          "--fake-provider",
        ],
        { cwd: "/fallback" },
      ),
    ).toEqual({
      name: "tui",
      directory: "/tmp/project",
      continueLast: false,
      sessionId: "session-1",
      model: "anthropic/example",
      permissionMode: "safe",
      fakeProvider: true,
    });
  });

  test("uses environment fake mode and rejects conflicting resume selectors", () => {
    expect(parseCliArgs([], { cwd: "/work", fakeProviderEnv: true })).toEqual({
      name: "tui",
      directory: "/work",
      continueLast: false,
      fakeProvider: true,
    });
    expect(() => parseCliArgs(["--continue", "--session", "id"])).toThrow(CliArgumentError);
  });

  test("parses auth and machine-readable commands", () => {
    expect(parseCliArgs(["auth", "login", "anthropic"])).toEqual({
      name: "auth",
      action: "login",
      provider: "anthropic",
      json: false,
    });
    expect(parseCliArgs(["auth", "logout", "--json"])).toEqual({
      name: "auth",
      action: "logout",
      json: true,
    });
    expect(parseCliArgs(["models", "--json", "--refresh"])).toEqual({
      name: "models",
      json: true,
      refresh: true,
    });
    expect(parseCliArgs(["doctor", "--json"])).toEqual({ name: "doctor", json: true });
    expect(parseCliArgs(["bench"])).toEqual({ name: "bench", json: false });
  });

  test("rejects malformed options instead of silently changing behavior", () => {
    expect(() => parseCliArgs(["--permission-mode", "unsafe"])).toThrow(
      "--permission-mode must be safe, write, or yolo",
    );
    expect(() => parseCliArgs(["--model", "missing-provider"])).toThrow(
      "--model must use provider/model format",
    );
    expect(() => parseCliArgs(["--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => parseCliArgs(["auth", "status", "anthropic"])).toThrow(
      "auth status does not accept a provider",
    );
  });
});
