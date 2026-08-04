import {
  Filesystem,
  InMemorySnapshotStore,
  NotFoundError,
  Patch,
  Patcher,
  SnapshotStore,
  computeFileHash,
  detectLineEnding,
  formatHashlineHeader,
  formatNumberedLine,
  formatNumberedLines,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type BlockResolver,
  type PatchSectionResult,
  type PreflightWriteOptions,
  type Snapshot,
  type WriteResult,
} from "@oh-my-pi/hashline";
import { createTwoFilesPatch } from "diff";
import { readFile, stat } from "node:fs/promises";
import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import {
  type HashlineChangePreview,
  type HashlineChangedFile,
  type HashlineEditInput,
  type HashlineReadInput,
  type HashlineReadResult,
  type HashlineWriteInput,
} from "../tools/hashline-workspace.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import { WorkspacePaths, type ResolvedWorkspacePath } from "../tools/workspace-paths.ts";

const DEFAULT_MAX_CAPTURED_FILES = 256;
const DEFAULT_MAX_CAPTURED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_READ_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PREVIEW_BYTES = 256 * 1024;
const UTF8_ENCODER = new TextEncoder();

export interface PatchOverlayArtifact {
  readonly content: string;
  readonly name: "changes.patch";
  readonly mediaType: "text/x-diff; charset=utf-8";
}

export type PatchOverlayArtifactOutput = (artifact: PatchOverlayArtifact) => Promise<string>;

export interface PatchOverlayWorkspaceOptions {
  readonly workspace: string | WorkspacePaths;
  readonly blockResolver?: BlockResolver;
  readonly artifactOutput?: PatchOverlayArtifactOutput;
  readonly maxCapturedFiles?: number;
  readonly maxCapturedBytes?: number;
  readonly maxReadOutputBytes?: number;
  readonly maxPreviewBytes?: number;
}

export interface PatchOverlayReadyResult {
  readonly status: "ready";
  readonly diff: string;
  readonly files: readonly string[];
  readonly artifactReference?: string;
}

export interface PatchOverlayBlockedResult {
  readonly status: "blocked";
  readonly blocker: string;
  readonly files: readonly [];
}

export type PatchOverlayFinalizeResult = PatchOverlayReadyResult | PatchOverlayBlockedResult;

export interface PatchOverlayTools {
  readonly read: ToolDefinition<HashlineReadInput>;
  readonly edit: ToolDefinition<HashlineEditInput>;
  readonly write: ToolDefinition<HashlineWriteInput>;
}

/**
 * Copy-on-read workspace used by patch-mode children. All mutations land in
 * memory; the real workspace is only read and drift-checked.
 */
export class PatchOverlayWorkspace {
  readonly paths: WorkspacePaths;
  readonly snapshots: InMemorySnapshotStore;
  readonly #filesystem: OverlayFilesystem;
  readonly #patcherOptions: { readonly blockResolver?: BlockResolver };
  readonly #artifactOutput: PatchOverlayArtifactOutput | undefined;
  readonly #maxReadOutputBytes: number;
  readonly #maxPreviewBytes: number;
  #state: "active" | "finalized" | "discarded" = "active";
  #finalResult: PatchOverlayFinalizeResult | undefined;

  constructor(options: PatchOverlayWorkspaceOptions) {
    this.paths =
      options.workspace instanceof WorkspacePaths
        ? options.workspace
        : new WorkspacePaths(options.workspace);
    const maxCapturedFiles = positiveBound(
      options.maxCapturedFiles,
      DEFAULT_MAX_CAPTURED_FILES,
      "captured files",
    );
    const maxCapturedBytes = positiveBound(
      options.maxCapturedBytes,
      DEFAULT_MAX_CAPTURED_BYTES,
      "captured bytes",
    );
    this.#filesystem = new OverlayFilesystem(this.paths, maxCapturedFiles, maxCapturedBytes);
    this.snapshots = new InMemorySnapshotStore({
      maxPaths: maxCapturedFiles,
      maxTotalBytes: maxCapturedBytes,
    });
    this.#patcherOptions =
      options.blockResolver === undefined ? {} : { blockResolver: options.blockResolver };
    this.#artifactOutput = options.artifactOutput;
    this.#maxReadOutputBytes = positiveBound(
      options.maxReadOutputBytes,
      DEFAULT_MAX_READ_OUTPUT_BYTES,
      "read output bytes",
    );
    this.#maxPreviewBytes = positiveBound(
      options.maxPreviewBytes,
      DEFAULT_MAX_PREVIEW_BYTES,
      "preview bytes",
    );
  }

  get state(): "active" | "finalized" | "discarded" {
    return this.#state;
  }

  get capturedFiles(): number {
    return this.#filesystem.capturedFiles;
  }

  get capturedBytes(): number {
    return this.#filesystem.capturedBytes;
  }

  async read(input: HashlineReadInput): Promise<HashlineReadResult> {
    this.assertActive();
    if (input.readOutsideWorkspace === true) {
      throw new PatchOverlayError("Patch overlays cannot read outside the workspace");
    }
    const resolved = this.paths.resolveWrite(input.path);
    const bytes = await this.#filesystem.readBinary(resolved.canonicalPath);
    if (bytes === undefined) {
      throw new PatchOverlayError(`Cannot read ${resolved.displayPath}: file does not exist`);
    }
    const normalized = normalizeToLF(stripBom(decodeUtf8(bytes, resolved.displayPath)).text);
    const lines = normalized.split("\n");
    const seenLines = selectLines(input.ranges, lines.length, resolved.displayPath);
    const tag = computeFileHash(normalized);
    const header = formatHashlineHeader(resolved.displayPath, tag);
    const body = formatReadBody(normalized, lines, seenLines, input.ranges !== undefined);
    const content = `${header}\n${body}`;
    const limit = positiveBound(
      input.maxOutputBytes,
      this.#maxReadOutputBytes,
      "read output bytes",
    );
    const outputBytes = UTF8_ENCODER.encode(content).byteLength;
    if (outputBytes > limit) {
      throw new PatchOverlayError(
        `Read output for ${resolved.displayPath} is ${outputBytes} bytes; maximum is ${limit}. Request a smaller line range.`,
      );
    }
    this.snapshots.record(resolved.canonicalPath, normalized, seenLines);
    return {
      path: resolved.displayPath,
      canonicalPath: resolved.canonicalPath,
      header,
      tag,
      content,
      seenLines,
      totalLines: lines.length,
    };
  }

  async edit(input: HashlineEditInput): Promise<HashlineChangePreview> {
    this.assertActive();
    let patch: Patch;
    try {
      patch = Patch.parse(input.patch, { cwd: this.paths.root });
      if (patch.sections.length === 0) throw new Error("Patch did not contain any edit sections");
      for (const section of patch.sections) {
        const parsed = section.parse();
        this.paths.resolveWrite(section.path, {
          operation: parsed.fileOp?.kind === "rem" ? "delete" : "write",
        });
        if (parsed.fileOp?.kind === "move") this.paths.resolveWrite(parsed.fileOp.dest);
      }
    } catch (error) {
      throw new PatchOverlayError(`Invalid Hashline patch: ${compactError(error)}`, {
        cause: error,
      });
    }

    const stagedFilesystem = this.#filesystem.fork();
    const stagedSnapshots = new BufferedSnapshotStore(this.snapshots);
    const patcher = new Patcher({
      fs: stagedFilesystem,
      snapshots: stagedSnapshots,
      ...this.#patcherOptions,
    });

    let sections: PatchSectionResult[];
    try {
      sections = (await patcher.apply(patch)).sections;
      if (sections.every((section) => section.op === "noop")) {
        throw new Error("Patch resulted in no changes");
      }
    } catch (error) {
      stagedSnapshots.discard();
      throw new PatchOverlayError(compactError(error), { cause: error });
    }

    const preview = this.makeEditPreview(patch, sections);
    try {
      enforceTextBound(preview.diff, input.maxPreviewBytes, this.#maxPreviewBytes, "preview");
    } catch (error) {
      stagedSnapshots.discard();
      throw error;
    }
    this.#filesystem.adopt(stagedFilesystem);
    stagedSnapshots.flush();
    return preview;
  }

  async write(input: HashlineWriteInput): Promise<HashlineChangePreview> {
    this.assertActive();
    if (input.content.includes("\0")) {
      throw new PatchOverlayError(`Refusing to write NUL/binary content to ${input.path}`);
    }
    const resolved = this.paths.resolveWrite(input.path);
    const stagedFilesystem = this.#filesystem.fork();
    const exists = await stagedFilesystem.exists(resolved.canonicalPath);
    const beforeRaw = exists ? await stagedFilesystem.readText(resolved.canonicalPath) : "";

    if (input.mode === "create" && exists) {
      throw new PatchOverlayError(
        `${resolved.displayPath} already exists; use mode "replace" for an explicit full replacement`,
      );
    }
    if (input.mode === "replace" && !exists) {
      throw new PatchOverlayError(
        `${resolved.displayPath} does not exist; use mode "create" for a new file`,
      );
    }

    const beforeBomText = stripBom(beforeRaw);
    const authored = stripBom(input.content);
    const before = normalizeToLF(beforeBomText.text);
    const after = normalizeToLF(authored.text);
    const lineEnding = exists
      ? detectDominantLineEnding(beforeBomText.text)
      : detectLineEnding(authored.text);
    const bom = exists ? beforeBomText.bom : authored.bom;
    const persisted = bom + restoreLineEndings(after, lineEnding);
    if (exists && persisted === beforeRaw) {
      throw new PatchOverlayError(`Replacement of ${resolved.displayPath} makes no changes`);
    }

    await stagedFilesystem.writeText(resolved.canonicalPath, persisted);
    const fileHash = computeFileHash(after);
    const header = formatHashlineHeader(resolved.displayPath, fileHash);
    const changedFile: HashlineChangedFile = {
      path: resolved.displayPath,
      op: exists ? "update" : "create",
      header,
      fileHash,
      warnings: [],
    };
    const diff = unifiedDiff(
      exists ? resolved.displayPath : "/dev/null",
      resolved.displayPath,
      before,
      after,
    );
    enforceTextBound(diff, input.maxPreviewBytes, this.#maxPreviewBytes, "preview");

    this.#filesystem.adopt(stagedFilesystem);
    this.snapshots.record(resolved.canonicalPath, after);
    return { kind: "write", diff, files: [changedFile] };
  }

  /** Freeze the overlay and produce a deterministic patch, or a drift blocker. */
  async finalize(): Promise<PatchOverlayFinalizeResult> {
    if (this.#state === "discarded") throw new PatchOverlayError("Patch overlay was discarded");
    if (this.#finalResult) return this.#finalResult;

    const drift = await this.#filesystem.findDrift();
    if (drift.length > 0) {
      this.#state = "finalized";
      this.#finalResult = {
        status: "blocked",
        blocker: `Real workspace changed after the overlay captured it:\n${drift.map((item) => `- ${item}`).join("\n")}`,
        files: [],
      };
      return this.#finalResult;
    }

    const changed = this.#filesystem.changedStates();
    const files = changed.map((entry) => this.paths.display(entry.canonicalPath));
    const diffs = changed.map((entry) => makeStateDiff(this.paths, entry));
    const diff = diffs.join("\n");
    const artifactReference =
      diff.length > 0 && this.#artifactOutput
        ? await this.#artifactOutput({
            content: diff,
            name: "changes.patch",
            mediaType: "text/x-diff; charset=utf-8",
          })
        : undefined;
    this.#state = "finalized";
    this.#finalResult = {
      status: "ready",
      diff,
      files,
      ...(artifactReference === undefined ? {} : { artifactReference }),
    };
    return this.#finalResult;
  }

  /** Destroy all captured originals, snapshots, and staged changes. */
  discard(): void {
    if (this.#state === "discarded") return;
    this.#filesystem.clear();
    this.snapshots.clear();
    this.#finalResult = undefined;
    this.#state = "discarded";
  }

  private makeEditPreview(
    patch: Patch,
    sections: readonly PatchSectionResult[],
  ): HashlineChangePreview {
    const files: HashlineChangedFile[] = [];
    const diffs: string[] = [];
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      const authored = patch.sections[index];
      if (!section || !authored) continue;
      const resultPath = this.paths.display(section.canonicalPath);
      const sourcePath =
        section.moveDest === undefined
          ? resultPath
          : this.paths.resolveWrite(authored.path).displayPath;
      const after = section.op === "delete" ? "" : section.after;
      const oldName = section.op === "create" ? "/dev/null" : sourcePath;
      const newName = section.op === "delete" ? "/dev/null" : resultPath;
      if (section.op !== "noop") {
        diffs.push(unifiedDiff(oldName, newName, section.before, after));
      }
      files.push({
        path: resultPath,
        op: section.op,
        header: formatHashlineHeader(resultPath, section.fileHash),
        fileHash: section.fileHash,
        warnings: section.warnings,
      });
    }
    return { kind: "edit", diff: diffs.join("\n"), files };
  }

  private assertActive(): void {
    if (this.#state !== "active") throw new PatchOverlayError(`Patch overlay is ${this.#state}`);
  }
}

export { PatchOverlayWorkspace as PatchOverlay };

export class PatchOverlayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PatchOverlayError";
  }
}

export function createPatchOverlayTools(overlay: PatchOverlayWorkspace): PatchOverlayTools {
  return {
    read: {
      name: "read",
      description:
        "Read a workspace UTF-8 text file from the isolated patch overlay with an exact Hashline snapshot header and numbered anchors. Range ends past EOF are clamped.",
      inputSchema: READ_SCHEMA,
      readOnly: true,
      parallelSafe: true,
      parse: parseReadInput,
      async execute(input) {
        return { content: (await overlay.read(input)).content };
      },
    },
    edit: {
      name: "edit",
      description:
        "Stage a native multi-file Hashline patch in the isolated overlay. Every section must use an exact [path#TAG] header returned by read.",
      inputSchema: EDIT_SCHEMA,
      parse: parseEditInput,
      async execute(input, context) {
        const preview = await overlay.edit(input);
        context.emitPreview({
          summary: preview.files.map((file) => file.path).join(", "),
          diff: preview.diff,
          targetPaths: preview.files.map((file) => file.path),
        });
        return { content: formatMutationResult(preview) };
      },
    },
    write: {
      name: "write",
      description:
        "Create or explicitly replace a UTF-8 text file in the isolated overlay. This never writes the real workspace.",
      inputSchema: WRITE_SCHEMA,
      parse: parseWriteInput,
      async execute(input, context) {
        const preview = await overlay.write(input);
        context.emitPreview({
          summary: preview.files.map((file) => file.path).join(", "),
          diff: preview.diff,
          targetPaths: preview.files.map((file) => file.path),
        });
        return { content: formatMutationResult(preview) };
      },
    },
  };
}

interface OverlayFileState {
  readonly canonicalPath: string;
  readonly baselineBytes: Uint8Array | undefined;
  currentBytes: Uint8Array | undefined;
}

class OverlayFilesystem extends Filesystem {
  readonly #paths: WorkspacePaths;
  readonly #maxFiles: number;
  readonly #maxBytes: number;
  readonly #states = new Map<string, OverlayFileState>();

  constructor(paths: WorkspacePaths, maxFiles: number, maxBytes: number) {
    super();
    this.#paths = paths;
    this.#maxFiles = maxFiles;
    this.#maxBytes = maxBytes;
  }

  get capturedFiles(): number {
    return this.#states.size;
  }

  get capturedBytes(): number {
    let total = 0;
    for (const state of this.#states.values()) total += stateSize(state);
    return total;
  }

  override canonicalPath(authoredPath: string): string {
    return this.#paths.resolveWrite(authoredPath).canonicalPath;
  }

  override allowTagPathRecovery(_authoredPath: string, resolvedPath: string): boolean {
    try {
      return this.#paths.resolveWrite(resolvedPath).canonicalPath === resolvedPath;
    } catch {
      return false;
    }
  }

  override async readText(authoredPath: string): Promise<string> {
    const resolved = this.#paths.resolveWrite(authoredPath);
    const state = await this.load(resolved);
    if (state.currentBytes === undefined) throw new NotFoundError(authoredPath);
    return decodeUtf8(state.currentBytes, resolved.displayPath);
  }

  override async readBinary(authoredPath: string): Promise<Uint8Array | undefined> {
    const resolved = this.#paths.resolveWrite(authoredPath);
    const state = await this.load(resolved);
    return state.currentBytes === undefined ? undefined : Uint8Array.from(state.currentBytes);
  }

  override async exists(authoredPath: string): Promise<boolean> {
    const resolved = this.#paths.resolveWrite(authoredPath);
    return (await this.load(resolved)).currentBytes !== undefined;
  }

  override async preflightWrite(
    authoredPath: string,
    options: PreflightWriteOptions = {},
  ): Promise<void> {
    const operation = options.fileOp?.kind === "rem" ? "delete" : "write";
    const source = this.#paths.resolveWrite(authoredPath, { operation });
    await this.load(source);
    if (options.fileOp?.kind === "move") {
      const destination = this.#paths.resolveWrite(options.fileOp.dest);
      if (destination.canonicalPath === source.canonicalPath) {
        throw new Error(`Move destination is the same as ${source.displayPath}`);
      }
      await this.load(destination);
    }
  }

  override async writeText(authoredPath: string, content: string): Promise<WriteResult> {
    if (content.includes("\0")) {
      throw new PatchOverlayError(`Refusing to write NUL/binary content to ${authoredPath}`);
    }
    const resolved = this.#paths.resolveWrite(authoredPath);
    const state = await this.load(resolved);
    const bytes = encodeUtf8(content, resolved.displayPath);
    this.replaceCurrent(new Map([[state.canonicalPath, bytes]]));
    return { text: content };
  }

  override async delete(authoredPath: string): Promise<void> {
    const resolved = this.#paths.resolveWrite(authoredPath, { operation: "delete" });
    const state = await this.load(resolved);
    if (state.currentBytes === undefined) throw new NotFoundError(authoredPath);
    this.replaceCurrent(new Map([[state.canonicalPath, undefined]]));
  }

  override async move(from: string, to: string, content?: string): Promise<void> {
    const source = this.#paths.resolveWrite(from);
    const destination = this.#paths.resolveWrite(to);
    if (source.canonicalPath === destination.canonicalPath) {
      throw new Error(`Move destination is the same as ${source.displayPath}`);
    }
    const sourceState = await this.load(source);
    const destinationState = await this.load(destination);
    if (sourceState.currentBytes === undefined) throw new NotFoundError(from);
    const destinationBytes =
      content === undefined
        ? Uint8Array.from(sourceState.currentBytes)
        : encodeUtf8(content, destination.displayPath);
    this.replaceCurrent(
      new Map([
        [sourceState.canonicalPath, undefined],
        [destinationState.canonicalPath, destinationBytes],
      ]),
    );
  }

  fork(): OverlayFilesystem {
    const fork = new OverlayFilesystem(this.#paths, this.#maxFiles, this.#maxBytes);
    for (const [canonicalPath, state] of this.#states) {
      const baseline = copyBytes(state.baselineBytes);
      const current = bytesEqual(state.baselineBytes, state.currentBytes)
        ? baseline
        : copyBytes(state.currentBytes);
      fork.#states.set(canonicalPath, {
        canonicalPath,
        baselineBytes: baseline,
        currentBytes: current,
      });
    }
    return fork;
  }

  adopt(source: OverlayFilesystem): void {
    this.#states.clear();
    for (const [canonicalPath, state] of source.#states) {
      const baseline = copyBytes(state.baselineBytes);
      const current = bytesEqual(state.baselineBytes, state.currentBytes)
        ? baseline
        : copyBytes(state.currentBytes);
      this.#states.set(canonicalPath, {
        canonicalPath,
        baselineBytes: baseline,
        currentBytes: current,
      });
    }
  }

  changedStates(): OverlayFileState[] {
    return [...this.#states.values()]
      .filter((state) => !bytesEqual(state.baselineBytes, state.currentBytes))
      .sort((left, right) =>
        compareStrings(
          this.#paths.display(left.canonicalPath),
          this.#paths.display(right.canonicalPath),
        ),
      );
  }

  async findDrift(): Promise<string[]> {
    const drift: string[] = [];
    const states = [...this.#states.values()].sort((left, right) =>
      compareStrings(left.canonicalPath, right.canonicalPath),
    );
    for (const state of states) {
      const displayPath = this.#paths.display(state.canonicalPath);
      try {
        this.#paths.revalidateWrite(state.canonicalPath);
        const live = await readDiskBytes(state.canonicalPath);
        this.#paths.revalidateWrite(state.canonicalPath);
        if (!bytesEqual(state.baselineBytes, live)) drift.push(`${displayPath} changed`);
      } catch (error) {
        drift.push(`${displayPath}: ${compactError(error)}`);
      }
    }
    return drift;
  }

  clear(): void {
    this.#states.clear();
  }

  private async load(resolved: ResolvedWorkspacePath): Promise<OverlayFileState> {
    const existing = this.#states.get(resolved.canonicalPath);
    if (existing) return existing;
    const diskBytes = await readDiskBytes(resolved.canonicalPath);
    this.#paths.revalidateWrite(resolved.canonicalPath);
    if (diskBytes !== undefined) decodeUtf8(diskBytes, resolved.displayPath);
    const raced = this.#states.get(resolved.canonicalPath);
    if (raced) return raced;
    if (this.#states.size + 1 > this.#maxFiles) {
      throw new PatchOverlayError(`Patch overlay would capture more than ${this.#maxFiles} files`);
    }
    if (this.capturedBytes + (diskBytes?.byteLength ?? 0) > this.#maxBytes) {
      throw new PatchOverlayError(`Patch overlay would capture more than ${this.#maxBytes} bytes`);
    }
    const baseline = copyBytes(diskBytes);
    const state: OverlayFileState = {
      canonicalPath: resolved.canonicalPath,
      baselineBytes: baseline,
      currentBytes: baseline,
    };
    this.#states.set(resolved.canonicalPath, state);
    return state;
  }

  private replaceCurrent(replacements: ReadonlyMap<string, Uint8Array | undefined>): void {
    let nextBytes = this.capturedBytes;
    for (const [canonicalPath, bytes] of replacements) {
      const state = this.#states.get(canonicalPath);
      if (!state) throw new Error(`Overlay state was not captured: ${canonicalPath}`);
      nextBytes -= stateSize(state);
      nextBytes += Math.max(state.baselineBytes?.byteLength ?? 0, bytes?.byteLength ?? 0);
    }
    if (nextBytes > this.#maxBytes) {
      throw new PatchOverlayError(`Patch overlay would capture more than ${this.#maxBytes} bytes`);
    }
    for (const [canonicalPath, bytes] of replacements) {
      const state = this.#states.get(canonicalPath);
      if (!state) throw new Error(`Overlay state was not captured: ${canonicalPath}`);
      state.currentBytes = copyBytes(bytes);
    }
  }
}

class BufferedSnapshotStore extends SnapshotStore {
  readonly #base: InMemorySnapshotStore;
  readonly #overlay = new InMemorySnapshotStore();
  readonly #operations: Array<() => void> = [];
  readonly #invalidated = new Set<string>();
  #closed = false;

  constructor(base: InMemorySnapshotStore) {
    super();
    this.#base = base;
  }

  override head(snapshotPath: string): Snapshot | null {
    return (
      this.#overlay.head(snapshotPath) ??
      (this.#invalidated.has(snapshotPath) ? null : this.#base.head(snapshotPath))
    );
  }

  override byHash(snapshotPath: string, hash: string): Snapshot | null {
    return (
      this.#overlay.byHash(snapshotPath, hash) ??
      (this.#invalidated.has(snapshotPath) ? null : this.#base.byHash(snapshotPath, hash))
    );
  }

  override byContent(snapshotPath: string, fullText: string): Snapshot | null {
    return (
      this.#overlay.byContent(snapshotPath, fullText) ??
      (this.#invalidated.has(snapshotPath) ? null : this.#base.byContent(snapshotPath, fullText))
    );
  }

  override findByHash(hash: string): Snapshot[] {
    const combined = [...this.#overlay.findByHash(hash)];
    for (const snapshot of this.#base.findByHash(hash)) {
      if (!this.#invalidated.has(snapshot.path)) combined.push(snapshot);
    }
    return combined;
  }

  override record(snapshotPath: string, fullText: string, seenLines?: Iterable<number>): string {
    this.assertOpen();
    const copiedSeen = seenLines === undefined ? undefined : [...seenLines];
    const hash = this.#overlay.record(snapshotPath, fullText, copiedSeen);
    this.#operations.push(() => this.#base.record(snapshotPath, fullText, copiedSeen));
    this.#invalidated.delete(snapshotPath);
    return hash;
  }

  override recordSeenLines(snapshotPath: string, hash: string, lines: Iterable<number>): void {
    this.assertOpen();
    const copied = [...lines];
    this.#overlay.recordSeenLines(snapshotPath, hash, copied);
    this.#operations.push(() => this.#base.recordSeenLines(snapshotPath, hash, copied));
  }

  override invalidate(snapshotPath: string): void {
    this.assertOpen();
    this.#overlay.invalidate(snapshotPath);
    this.#invalidated.add(snapshotPath);
    this.#operations.push(() => this.#base.invalidate(snapshotPath));
  }

  override relocate(from: string, to: string): void {
    this.assertOpen();
    this.#overlay.relocate(from, to);
    this.#invalidated.add(from);
    this.#invalidated.delete(to);
    this.#operations.push(() => this.#base.relocate(from, to));
  }

  override clear(): void {
    this.assertOpen();
    this.#overlay.clear();
    this.#operations.push(() => this.#base.clear());
  }

  flush(): void {
    this.assertOpen();
    this.#closed = true;
    for (const operation of this.#operations) operation();
    this.#operations.length = 0;
  }

  discard(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#operations.length = 0;
    this.#overlay.clear();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Snapshot transaction is closed");
  }
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    ranges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "integer", minimum: 1 },
          end: {
            type: "integer",
            minimum: 1,
            description: "Inclusive end line; values past EOF are clamped.",
          },
        },
        required: ["start"],
        additionalProperties: false,
      },
    },
    maxOutputBytes: { type: "integer", minimum: 1 },
  },
  required: ["path"],
  additionalProperties: false,
} satisfies JsonSchema;

const EDIT_SCHEMA = {
  type: "object",
  properties: { patch: { type: "string", minLength: 1 } },
  required: ["patch"],
  additionalProperties: false,
} satisfies JsonSchema;

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string" },
    mode: { type: "string", enum: ["create", "replace"] },
  },
  required: ["path", "content", "mode"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseReadInput(value: JsonValue): HashlineReadInput {
  const object = requireObject(value);
  if (typeof object.path !== "string") throw new Error("path must be a string");
  let ranges: HashlineReadInput["ranges"];
  if (object.ranges !== undefined) {
    if (!Array.isArray(object.ranges)) throw new Error("ranges must be an array");
    ranges = object.ranges.map((range) => {
      const item = requireObject(range);
      if (typeof item.start !== "number") throw new Error("range start must be a number");
      return {
        start: item.start,
        ...(typeof item.end === "number" ? { end: item.end } : {}),
      };
    });
  }
  return {
    path: object.path,
    ...(ranges === undefined ? {} : { ranges }),
    ...(typeof object.maxOutputBytes === "number" ? { maxOutputBytes: object.maxOutputBytes } : {}),
  };
}

function parseEditInput(value: JsonValue): HashlineEditInput {
  const object = requireObject(value);
  if (typeof object.patch !== "string") throw new Error("patch must be a string");
  return { patch: object.patch };
}

function parseWriteInput(value: JsonValue): HashlineWriteInput {
  const object = requireObject(value);
  if (typeof object.path !== "string") throw new Error("path must be a string");
  if (typeof object.content !== "string") throw new Error("content must be a string");
  if (object.mode !== "create" && object.mode !== "replace") {
    throw new Error('mode must be "create" or "replace"');
  }
  return { path: object.path, content: object.content, mode: object.mode };
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function formatMutationResult(preview: HashlineChangePreview): string {
  const warnings = preview.files.flatMap((file) =>
    file.warnings.map((warning) => `${file.path}: ${warning}`),
  );
  return [
    `${preview.kind === "edit" ? "Edit" : "Write"} staged in isolated patch overlay:`,
    ...preview.files.map((file) => `- ${file.op} ${file.path} ${file.header}`),
    ...(warnings.length === 0 ? [] : ["Warnings:", ...warnings.map((warning) => `- ${warning}`)]),
    "",
    preview.diff,
  ].join("\n");
}

async function readDiskBytes(canonicalPath: string): Promise<Uint8Array | undefined> {
  try {
    const [bytes, metadata] = await Promise.all([readFile(canonicalPath), stat(canonicalPath)]);
    if (!metadata.isFile()) throw new Error(`Not a regular file: ${canonicalPath}`);
    return Uint8Array.from(bytes);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function makeStateDiff(paths: WorkspacePaths, state: OverlayFileState): string {
  const displayPath = paths.display(state.canonicalPath);
  const before = decodeUtf8(state.baselineBytes ?? new Uint8Array(), displayPath);
  const after = decodeUtf8(state.currentBytes ?? new Uint8Array(), displayPath);
  return unifiedDiff(
    state.baselineBytes === undefined ? "/dev/null" : displayPath,
    state.currentBytes === undefined ? "/dev/null" : displayPath,
    before,
    after,
  );
}

function decodeUtf8(bytes: Uint8Array, displayPath: string): string {
  if (bytes.includes(0)) {
    throw new PatchOverlayError(`Refusing to read NUL/binary file: ${displayPath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new PatchOverlayError(`File is not valid UTF-8: ${displayPath}`, { cause: error });
  }
}

function encodeUtf8(text: string, displayPath: string): Uint8Array {
  const bytes = UTF8_ENCODER.encode(text);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== text) {
    throw new PatchOverlayError(`Text contains an unpaired Unicode surrogate: ${displayPath}`);
  }
  return bytes;
}

function selectLines(
  ranges: HashlineReadInput["ranges"],
  totalLines: number,
  displayPath: string,
): number[] {
  if (ranges === undefined) return Array.from({ length: totalLines }, (_, index) => index + 1);
  if (ranges.length === 0) throw new PatchOverlayError("At least one line range is required");
  const selected = new Set<number>();
  for (const range of ranges) {
    const end = range.end ?? range.start;
    if (!Number.isSafeInteger(range.start) || range.start < 1) {
      throw new PatchOverlayError(
        `Range start must be a positive safe integer; got ${range.start}`,
      );
    }
    if (!Number.isSafeInteger(end) || end < range.start) {
      throw new PatchOverlayError(`Invalid line range ${range.start}-${end}`);
    }
    if (range.start > totalLines) {
      throw new PatchOverlayError(
        `Line range ${range.start}-${end} starts outside ${displayPath}, which has ${totalLines} lines`,
      );
    }
    const clampedEnd = Math.min(end, totalLines);
    for (let line = range.start; line <= clampedEnd; line += 1) selected.add(line);
  }
  return [...selected].sort((left, right) => left - right);
}

function formatReadBody(
  normalized: string,
  lines: readonly string[],
  seenLines: readonly number[],
  partial: boolean,
): string {
  if (!partial) return formatNumberedLines(normalized);
  const output: string[] = [];
  let previous = 0;
  for (const line of seenLines) {
    if (previous !== 0 && line > previous + 1) output.push("...");
    output.push(formatNumberedLine(line, lines[line - 1] ?? ""));
    previous = line;
  }
  return output.join("\n");
}

function detectDominantLineEnding(text: string): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    if (index > 0 && text[index - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  if (crlf === lf) return detectLineEnding(text);
  return crlf > lf ? "\r\n" : "\n";
}

function unifiedDiff(oldPath: string, newPath: string, before: string, after: string): string {
  return createTwoFilesPatch(oldPath, newPath, before, after, "", "", { context: 3 });
}

function enforceTextBound(
  text: string,
  requested: number | undefined,
  fallback: number,
  label: string,
): void {
  const limit = positiveBound(requested, fallback, `${label} bytes`);
  const size = UTF8_ENCODER.encode(text).byteLength;
  if (size > limit) {
    throw new PatchOverlayError(`${label} is ${size} bytes; maximum is ${limit}`);
  }
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound < 1) {
    throw new RangeError(`Maximum ${label} must be a positive safe integer`);
  }
  return bound;
}

function stateSize(state: OverlayFileState): number {
  return Math.max(state.baselineBytes?.byteLength ?? 0, state.currentBytes?.byteLength ?? 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyBytes(bytes: Uint8Array | undefined): Uint8Array | undefined {
  return bytes === undefined ? undefined : Uint8Array.from(bytes);
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.length > 4_000 ? `${message.slice(0, 3_999)}…` : message;
  return compact.replace(/\n{3,}/g, "\n\n");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
