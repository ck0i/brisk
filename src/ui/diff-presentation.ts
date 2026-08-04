import { formatPatch, parsePatch, type StructuredPatch } from "diff";

export interface DiffPreviewSection {
  readonly diff: string;
  readonly rows: number;
  readonly path: string | undefined;
}

/** Split a unified diff into independently sized file/hunk renderables. */
export function splitDiffPreview(diff: string): readonly DiffPreviewSection[] {
  try {
    const sections = parsePatch(diff).flatMap((patch) =>
      patch.hunks.map((hunk) => ({
        diff: formatPatch({ ...patch, hunks: [hunk] } satisfies StructuredPatch),
        rows: Math.max(1, hunk.lines.filter(isRenderedDiffLine).length),
        path: displayPatchPath(patch),
      })),
    );
    if (sections.length > 0) return sections;
  } catch {
    // Let OpenTUI display its normal parse diagnostic for malformed extension diffs.
  }

  return [{ diff, rows: visibleLineCount(diff), path: undefined }];
}

export function diffSectionHeight(section: DiffPreviewSection, maximum = 18): number {
  return Math.min(maximum, Math.max(1, section.rows));
}

function isRenderedDiffLine(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("+") || line.startsWith("-");
}

function displayPatchPath(patch: StructuredPatch): string | undefined {
  const value = patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName;
  return value || undefined;
}

function visibleLineCount(value: string): number {
  const trimmed = value.replace(/(?:\r?\n)+$/, "");
  return Math.max(1, trimmed.length === 0 ? 1 : trimmed.split(/\r?\n/).length);
}
