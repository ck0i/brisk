import { describe, expect, test } from "bun:test";

import {
  extractToolDiff,
  summarizeToolCall,
  summarizeToolResult,
} from "../../src/ui/tool-presentation.ts";

describe("tool presentation", () => {
  test("derives concise mutation targets from finalized tool arguments", () => {
    expect(
      summarizeToolCall({
        id: "write-1",
        name: "write",
        arguments: JSON.stringify({ path: "src/value.ts", content: "value", mode: "replace" }),
      }),
    ).toBe("src/value.ts");
    expect(
      summarizeToolCall({
        id: "edit-1",
        name: "edit",
        arguments: JSON.stringify({
          patch: "[src/one.ts#AAAA]\n...\n[src/two.ts#BBBB]\n...",
        }),
      }),
    ).toBe("src/one.ts, src/two.ts");
  });

  test("extracts direct mutation diffs and delegated patch results", () => {
    const diff = "--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-before\n+after\n";
    expect(extractToolDiff("edit", `Edit committed\n\n${diff}`)).toBe(diff);
    expect(extractToolDiff("bash", `${diff} M value.ts\n\n[exit=0]`)).toBeUndefined();
    expect(
      extractToolDiff(
        "task",
        JSON.stringify({ status: "completed", summary: "patched", patch: diff }),
      ),
    ).toBe(diff);
    const proseResult = JSON.stringify({
      status: "completed",
      summary: "Repository review completed",
      patch: "Technical overview:\n\nNo files were changed.",
    });
    expect(extractToolDiff("task", proseResult)).toBeUndefined();
    expect(summarizeToolResult("task", proseResult)).toBe("Repository review completed");
  });
});
