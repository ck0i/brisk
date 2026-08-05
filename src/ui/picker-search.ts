import type { UiPickerOption } from "./state.ts";

export interface RankedPickerOption {
  readonly option: UiPickerOption;
  readonly index: number;
}

/** Filters and ranks picker options with case-insensitive, multi-term fuzzy matching. */
export function rankPickerOptions(
  options: readonly UiPickerOption[],
  query: string | undefined,
): RankedPickerOption[] {
  const terms = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options.map((option, index) => ({ option, index }));

  return options
    .map((option, index) => {
      const fields = [option.label, option.id, option.description ?? "", option.searchText ?? ""]
        .map((field) => field.toLowerCase())
        .filter(Boolean);
      let score = 0;
      for (const term of terms) {
        const termScore = lowestScore(fields, term);
        if (termScore === undefined) return undefined;
        score += termScore;
      }
      return { option, index, score };
    })
    .filter(
      (match): match is RankedPickerOption & { readonly score: number } => match !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ option, index }) => ({ option, index }));
}

function lowestScore(fields: readonly string[], query: string): number | undefined {
  let best: number | undefined;
  for (const field of fields) {
    const score = fuzzyScore(field, query);
    if (score !== undefined && (best === undefined || score < best)) best = score;
  }
  return best;
}

function fuzzyScore(value: string, query: string): number | undefined {
  if (value === query) return 0;

  const contiguousIndex = value.indexOf(query);
  if (contiguousIndex !== -1) {
    const startsAtBoundary =
      contiguousIndex === 0 || !isAlphaNumeric(value.charAt(contiguousIndex - 1));
    return (startsAtBoundary ? 10 : 20) + contiguousIndex;
  }

  let previousIndex = -1;
  let firstIndex = -1;
  let gapCount = 0;
  for (const character of query) {
    const index = value.indexOf(character, previousIndex + 1);
    if (index === -1) return undefined;
    if (firstIndex === -1) firstIndex = index;
    if (previousIndex !== -1) gapCount += index - previousIndex - 1;
    previousIndex = index;
  }

  return 100 + firstIndex * 2 + gapCount * 4;
}

function isAlphaNumeric(character: string): boolean {
  return /[a-z0-9]/i.test(character);
}
