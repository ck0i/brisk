import { describe, expect, test } from "bun:test";

import { rankPickerOptions } from "../../src/ui/picker-search.ts";
import type { UiPickerOption } from "../../src/ui/state.ts";

const MODELS: readonly UiPickerOption[] = [
  { id: "openai/gpt-5", label: "openai/gpt-5" },
  { id: "cursor/composer-1", label: "cursor/composer-1" },
  { id: "cursor/composer-1-fast", label: "cursor/composer-1-fast" },
  { id: "cursor/sonnet-4", label: "cursor/sonnet-4" },
  { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
];

describe("rankPickerOptions", () => {
  test("finds provider and model-name substrings case-insensitively", () => {
    expect(idsFor("CUR")).toEqual([
      "cursor/composer-1",
      "cursor/composer-1-fast",
      "cursor/sonnet-4",
    ]);
    expect(idsFor("compo")).toEqual(["cursor/composer-1", "cursor/composer-1-fast"]);
  });

  test("supports fuzzy subsequences and multiple search terms", () => {
    expect(idsFor("cmpsr")).toEqual(["cursor/composer-1", "cursor/composer-1-fast"]);
    expect(idsFor("cur fast")).toEqual(["cursor/composer-1-fast"]);
  });

  test("matches hidden display-name keywords without changing the rendered label", () => {
    const options: readonly UiPickerOption[] = [
      { id: "custom/model-1", label: "custom/model-1", searchText: "Kimi K2 Thinking" },
      { id: "custom/model-2", label: "custom/model-2", searchText: "DeepSeek V3" },
    ];

    expect(rankPickerOptions(options, "kimi").map((row) => row.option.id)).toEqual([
      "custom/model-1",
    ]);
  });

  test("preserves source order when the query is empty and returns no unrelated options", () => {
    expect(idsFor("")).toEqual(MODELS.map((model) => model.id));
    expect(idsFor("gemini")).toEqual([]);
  });
});

function idsFor(query: string): string[] {
  return rankPickerOptions(MODELS, query).map((row) => row.option.id);
}
