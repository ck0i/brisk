import type { ArtifactMetadata } from "./artifact-store.ts";
import { ArtifactStore } from "./artifact-store.ts";

export const DEFAULT_OUTPUT_HEAD_CHARS = 24_000;
export const DEFAULT_OUTPUT_TAIL_CHARS = 8_000;

export interface OutputLimitOptions {
  readonly headChars?: number;
  readonly tailChars?: number;
  readonly artifactName?: string;
  readonly mediaType?: string;
}

export interface OutputCounts {
  readonly chars: number;
  readonly bytes: number;
  readonly lines: number;
}

export interface LimitedOutput {
  readonly content: string;
  readonly truncated: boolean;
  readonly original: OutputCounts;
  readonly omitted: OutputCounts;
  readonly artifact?: ArtifactMetadata;
}

interface OutputSnapshot {
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
  readonly original: OutputCounts;
  readonly omitted: OutputCounts;
}

export class OutputLimiter {
  private readonly headChars: number;
  private readonly tailChars: number;

  constructor(
    private readonly artifacts: ArtifactStore,
    options: OutputLimitOptions = {},
  ) {
    this.headChars = validateLimit(options.headChars ?? DEFAULT_OUTPUT_HEAD_CHARS, "headChars");
    this.tailChars = validateLimit(options.tailChars ?? DEFAULT_OUTPUT_TAIL_CHARS, "tailChars");
    if (this.headChars + this.tailChars === 0) {
      throw new RangeError("At least one output boundary must be retained");
    }
    this.options = options;
  }

  private readonly options: OutputLimitOptions;

  async limit(content: string): Promise<LimitedOutput> {
    const stream = new StreamingOutputLimiter({
      headChars: this.headChars,
      tailChars: this.tailChars,
    });
    stream.write(content);
    const snapshot = stream.snapshot();
    if (!snapshot.truncated) return formatSnapshot(snapshot);

    const artifact = await this.artifacts.write(content, {
      name: this.options.artifactName ?? "full-output.txt",
      mediaType: this.options.mediaType ?? "text/plain; charset=utf-8",
      encoding: "utf-8",
    });
    return formatSnapshot(snapshot, artifact);
  }
}

export class StreamingOutputLimiter {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private totalChars = 0;
  private totalBytes = 0;
  private totalBreaks = 0;
  private totalPrevious = "";
  private omittedChars = 0;
  private omittedBytes = 0;
  private omittedBreaks = 0;
  private omittedPrevious = "";

  constructor(options: OutputLimitOptions = {}) {
    this.headLimit = validateLimit(options.headChars ?? DEFAULT_OUTPUT_HEAD_CHARS, "headChars");
    this.tailLimit = validateLimit(options.tailChars ?? DEFAULT_OUTPUT_TAIL_CHARS, "tailChars");
    if (this.headLimit + this.tailLimit === 0) {
      throw new RangeError("At least one output boundary must be retained");
    }
  }

  write(content: string): void {
    for (const character of content) {
      const bytes = utf8Length(character);
      this.totalChars += 1;
      this.totalBytes += bytes;
      this.totalBreaks += lineBreakIncrement(this.totalPrevious, character);
      this.totalPrevious = character;

      if (this.head.length < this.headLimit) {
        this.head.push(character);
        continue;
      }
      this.tail.push(character);
      if (this.tail.length <= this.tailLimit) continue;
      const omitted = this.tail.shift();
      if (omitted === undefined) throw new Error("Output limiter tail invariant failed");
      this.omittedChars += 1;
      this.omittedBytes += utf8Length(omitted);
      this.omittedBreaks += lineBreakIncrement(this.omittedPrevious, omitted);
      this.omittedPrevious = omitted;
    }
  }

  snapshot(): OutputSnapshot {
    const originalLines = this.totalChars === 0 ? 0 : this.totalBreaks + 1;
    const omittedLines = this.omittedChars === 0 ? 0 : this.omittedBreaks + 1;
    return {
      head: this.head.join(""),
      tail: this.tail.join(""),
      truncated: this.omittedChars > 0,
      original: {
        chars: this.totalChars,
        bytes: this.totalBytes,
        lines: originalLines,
      },
      omitted: {
        chars: this.omittedChars,
        bytes: this.omittedBytes,
        lines: omittedLines,
      },
    };
  }

  finish(artifact?: ArtifactMetadata): LimitedOutput {
    return formatSnapshot(this.snapshot(), artifact);
  }
}

export async function limitOutput(
  content: string,
  artifacts: ArtifactStore,
  options: OutputLimitOptions = {},
): Promise<LimitedOutput> {
  return await new OutputLimiter(artifacts, options).limit(content);
}

function formatSnapshot(snapshot: OutputSnapshot, artifact?: ArtifactMetadata): LimitedOutput {
  if (!snapshot.truncated) {
    return {
      content: snapshot.head + snapshot.tail,
      truncated: false,
      original: snapshot.original,
      omitted: snapshot.omitted,
    };
  }
  if (!artifact) throw new Error("Truncated output requires a full-output artifact");
  const notice = [
    "[output truncated:",
    `${snapshot.omitted.chars} chars,`,
    `${snapshot.omitted.bytes} bytes,`,
    `${snapshot.omitted.lines} lines omitted;`,
    `full output: ${artifact.reference}]`,
  ].join(" ");
  return {
    content: `${snapshot.head}\n\n${notice}\n\n${snapshot.tail}`,
    truncated: true,
    original: snapshot.original,
    omitted: snapshot.omitted,
    artifact,
  };
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function utf8Length(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function lineBreakIncrement(previous: string, character: string): number {
  if (character === "\r") return 1;
  if (character === "\n") return previous === "\r" ? 0 : 1;
  return character === "\u2028" || character === "\u2029" ? 1 : 0;
}
