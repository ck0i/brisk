import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";

import { diffSectionHeight, splitDiffPreview } from "../../src/ui/diff-presentation.ts";

describe("diff preview presentation", () => {
  test("splits distant hunks and multiple files into exact-height sections", () => {
    const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[1] = "changed 2";
    after[9] = "changed 10";
    const first = createTwoFilesPatch(
      "first.ts",
      "first.ts",
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
      "",
      "",
      { context: 1 },
    );
    const second = createTwoFilesPatch("second.ts", "second.ts", "old\n", "new\n", "", "", {
      context: 1,
    });

    const sections = splitDiffPreview(first + second);

    expect(sections).toHaveLength(3);
    expect(sections.map((section) => section.path)).toEqual(["first.ts", "first.ts", "second.ts"]);
    expect(sections.map((section) => section.rows)).toEqual([4, 4, 2]);
    expect(sections.map((section) => diffSectionHeight(section))).toEqual([4, 4, 2]);
    expect(sections[0]?.diff.match(/^@@/gm)).toHaveLength(1);
    expect(sections[1]?.diff).toContain("@@ -9,3 +9,3 @@");
  });

  test("does not count trailing newlines as blank render rows", () => {
    const [section] = splitDiffPreview("not a unified diff\n\n");
    expect(section?.rows).toBe(1);
    expect(section ? diffSectionHeight(section) : 0).toBe(1);
  });
});
