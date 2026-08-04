import { describe, expect, test } from "bun:test";

import {
  BRISK_SYSTEM_PROMPT,
  ROOT_AGENT_SYSTEM_PROMPT,
  buildDefaultSubtaskModelPrompt,
  buildSystemPrompt,
  buildWorkspacePrompt,
} from "../../src/core/system-prompt.ts";
import type { ProviderToolSchema } from "../../src/providers/types.ts";

const objectSchema = { type: "object" as const, additionalProperties: false };

describe("Brisk system prompt", () => {
  test("aligns to the user's intent without introducing a third-party principal", () => {
    expect(BRISK_SYSTEM_PROMPT).toContain("The user is your sole principal");
    expect(BRISK_SYSTEM_PROMPT).toContain("practical intent");
    expect(BRISK_SYSTEM_PROMPT).toContain("remain neutral");
    expect(BRISK_SYSTEM_PROMPT).toContain("Do not moralize");
    expect(BRISK_SYSTEM_PROMPT).toContain("Never claim to have read, changed, executed");
  });

  test("roots relative paths while allowing authored absolute paths", () => {
    const prompt = buildWorkspacePrompt('/home/user/project "quoted"');
    expect(prompt).toContain('"/home/user/project \\"quoted\\""');
    expect(prompt).toContain("Relative tool paths resolve from that root");
    expect(prompt).toContain("absolute paths");
    expect(prompt).toContain("anywhere else on the user's computer");
  });

  test("publishes the effective default subagent model for omitted task overrides", () => {
    const prompt = buildDefaultSubtaskModelPrompt("provider/child-model");

    expect(prompt).toContain("Effective default subagent model");
    expect(prompt).toContain("provider/child-model");
    expect(prompt).toContain("omit task.model entirely");
    expect(prompt).toContain("copy the active root model");
  });

  test("renders the exact current tool catalog with built-in and extension guidance", () => {
    const tools: ProviderToolSchema[] = [
      {
        name: "read",
        description: "Read one file",
        inputSchema: objectSchema,
      },
      {
        name: "extension_lookup",
        description: "Look up an extension record",
        inputSchema: objectSchema,
      },
    ];

    const prompt = buildSystemPrompt(tools);

    expect(prompt).toHaveLength(3);
    expect(prompt[0]).toBe(BRISK_SYSTEM_PROMPT);
    expect(prompt[1]).toBe(ROOT_AGENT_SYSTEM_PROMPT);
    expect(prompt[2]).toContain("Only the tools listed below are callable");
    expect(prompt[2]).toContain('{"name":"read","description":"Read one file"}');
    expect(prompt[2]).toContain("[path#TAG] Hashline header");
    expect(prompt[2]).toContain(
      '{"name":"extension_lookup","description":"Look up an extension record"}',
    );
    expect(prompt[2]).not.toContain('"name":"write"');
  });

  test("places discovered instruction blocks between the stable prompt and tool catalog", () => {
    const prompt = buildSystemPrompt([], ["user AGENTS", "repository AGENTS"]);

    expect(prompt).toEqual([
      BRISK_SYSTEM_PROMPT,
      "user AGENTS",
      "repository AGENTS",
      ROOT_AGENT_SYSTEM_PROMPT,
      expect.stringContaining("No tools are available"),
    ]);
  });

  test("requires task calls to omit model unless the user explicitly selected one", () => {
    const prompt = buildSystemPrompt([
      { name: "task", description: "Run child", inputSchema: objectSchema },
    ]);

    expect(prompt.at(-2)).toContain("if the user did not explicitly specify a model");
    expect(prompt.at(-2)).toContain("starts the child in the background");
    expect(prompt.at(-2)).toContain("continue useful work yourself");
    expect(prompt.at(-1)).toContain("MUST omit model from the tool call entirely");
    expect(prompt.at(-1)).toContain("configured default subtask model");
  });

  test("supports an explicit delegated session role", () => {
    const childRole = "delegated child role";
    expect(buildSystemPrompt([], [], childRole)).toEqual([
      BRISK_SYSTEM_PROMPT,
      childRole,
      expect.stringContaining("No tools are available"),
    ]);
  });

  test("states explicitly when the agent has no tools", () => {
    expect(buildSystemPrompt([]).at(-1)).toContain("No tools are available");
  });
});
