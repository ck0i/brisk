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
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { WorkspacePaths, type ResolvedWorkspacePath } from "./workspace-paths.ts";

const DEFAULT_MAX_READ_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PREVIEW_BYTES = 256 * 1024;
const UTF8_ENCODER = new TextEncoder();

export interface ArtifactReader {
  read(uri: string): Promise<Uint8Array>;
}

export interface WorkspaceMutationIO {
  writeFile(filePath: string, bytes: Uint8Array, mode?: number): Promise<void>;
  removeFile(filePath: string): Promise<void>;
}

export interface HashlineWorkspaceOptions {
  readonly workspace: string | WorkspacePaths;
  readonly artifactReader?: ArtifactReader;
  readonly blockResolver?: BlockResolver;
  readonly mutationIO?: WorkspaceMutationIO;
  readonly maxReadOutputBytes?: number;
  readonly maxPreviewBytes?: number;
}

export interface ReadLineRange {
  readonly start: number;
  readonly end?: number;
}

export interface HashlineReadInput {
  readonly path: string;
  readonly ranges?: readonly ReadLineRange[];
  readonly readOutsideWorkspace?: boolean;
  readonly maxOutputBytes?: number;
}

export interface HashlineReadResult {
  readonly path: string;
  readonly canonicalPath: string;
  readonly header: string;
  readonly tag: string;
  readonly content: string;
  readonly seenLines: readonly number[];
  readonly totalLines: number;
}

export interface HashlineEditInput {
  /** A complete native Hashline patch, including every [path#TAG] header. */
  readonly patch: string;
  readonly maxPreviewBytes?: number;
}

export interface HashlineWriteInput {
  readonly path: string;
  readonly content: string;
  readonly mode: "create" | "replace";
  readonly maxPreviewBytes?: number;
}

export interface HashlineChangedFile {
  readonly path: string;
  readonly op: "create" | "update" | "delete" | "noop";
  readonly header: string;
  readonly fileHash: string;
  readonly warnings: readonly string[];
}

export interface HashlineChangePreview {
  readonly kind: "edit" | "write";
  readonly diff: string;
  readonly files: readonly HashlineChangedFile[];
}

export interface HashlineChangeResult extends HashlineChangePreview {
  readonly committed: true;
}

/** A prepared change that has not touched the real workspace yet. */
export class PendingHashlineChange {
  readonly preview: HashlineChangePreview;
  #state: "pending" | "committed" | "discarded" = "pending";
  readonly #commitChange: () => Promise<void>;
  readonly #discardChange: () => void;

  constructor(
    preview: HashlineChangePreview,
    commitChange: () => Promise<void>,
    discardChange: () => void,
  ) {
    this.preview = preview;
    this.#commitChange = commitChange;
    this.#discardChange = discardChange;
  }

  get state(): "pending" | "committed" | "discarded" {
    return this.#state;
  }

  async commit(): Promise<HashlineChangeResult> {
    if (this.#state !== "pending") throw new Error(`Change is already ${this.#state}`);
    this.#state = "discarded";
    await this.#commitChange();
    this.#state = "committed";
    return { ...this.preview, committed: true };
  }

  discard(): void {
    if (this.#state !== "pending") throw new Error(`Change is already ${this.#state}`);
    this.#discardChange();
    this.#state = "discarded";
  }
}

/** Shared read/edit/write foundation backed by one upstream Hashline snapshot store. */
export class HashlineWorkspace {
  readonly paths: WorkspacePaths;
  readonly snapshots = new InMemorySnapshotStore();
  readonly #artifactReader: ArtifactReader | undefined;
  readonly #blockResolver: BlockResolver | undefined;
  readonly #mutationIO: WorkspaceMutationIO;
  readonly #maxReadOutputBytes: number;
  readonly #maxPreviewBytes: number;

  constructor(options: HashlineWorkspaceOptions) {
    this.paths =
      options.workspace instanceof WorkspacePaths
        ? options.workspace
        : new WorkspacePaths(options.workspace);
    this.#artifactReader = options.artifactReader;
    this.#blockResolver = options.blockResolver;
    this.#mutationIO = options.mutationIO ?? new AtomicWorkspaceMutationIO();
    this.#maxReadOutputBytes = positiveBound(
      options.maxReadOutputBytes,
      DEFAULT_MAX_READ_OUTPUT_BYTES,
      "read output",
    );
    this.#maxPreviewBytes = positiveBound(
      options.maxPreviewBytes,
      DEFAULT_MAX_PREVIEW_BYTES,
      "preview",
    );
  }

  async read(input: HashlineReadInput): Promise<HashlineReadResult> {
    const source = await this.readSource(input);
    const normalized = normalizeToLF(stripBom(decodeUtf8(source.bytes, source.displayPath)).text);
    const lines = normalized.split("\n");
    const seenLines = selectLines(input.ranges, lines.length, source.displayPath);
    const tag = computeFileHash(normalized);
    const header = formatHashlineHeader(source.displayPath, tag);
    const body = formatReadBody(normalized, lines, seenLines, input.ranges !== undefined);
    const content = `${header}\n${body}`;
    const limit = positiveBound(input.maxOutputBytes, this.#maxReadOutputBytes, "read output");
    const outputBytes = UTF8_ENCODER.encode(content).byteLength;
    if (outputBytes > limit) {
      throw new HashlineWorkspaceError(
        `Read output for ${source.displayPath} is ${outputBytes} bytes; maximum is ${limit}. Request a smaller line range.`,
      );
    }
    this.snapshots.record(source.canonicalPath, normalized, seenLines);

    return {
      path: source.displayPath,
      canonicalPath: source.canonicalPath,
      header,
      tag,
      content,
      seenLines,
      totalLines: lines.length,
    };
  }

  async edit(input: HashlineEditInput): Promise<PendingHashlineChange> {
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
      throw new HashlineWorkspaceError(`Invalid Hashline patch: ${compactError(error)}`, {
        cause: error,
      });
    }

    const filesystem = new TransactionalWorkspaceFilesystem(this.paths, this.#mutationIO);
    const bufferedSnapshots = new BufferedSnapshotStore(this.snapshots);
    const patcher = new Patcher({
      fs: filesystem,
      snapshots: bufferedSnapshots,
      ...(this.#blockResolver === undefined ? {} : { blockResolver: this.#blockResolver }),
    });

    let sections: PatchSectionResult[];
    try {
      sections = (await patcher.apply(patch)).sections;
      if (sections.every((section) => section.op === "noop")) {
        throw new Error("Patch resulted in no changes");
      }
    } catch (error) {
      filesystem.discard();
      bufferedSnapshots.discard();
      throw new HashlineWorkspaceError(compactError(error), { cause: error });
    }

    const preview = this.makeEditPreview(patch, sections);
    try {
      enforcePreviewBound(preview.diff, input.maxPreviewBytes, this.#maxPreviewBytes);
    } catch (error) {
      filesystem.discard();
      bufferedSnapshots.discard();
      throw error;
    }
    return new PendingHashlineChange(
      preview,
      async () => {
        try {
          await filesystem.publish();
          bufferedSnapshots.flush();
        } catch (error) {
          bufferedSnapshots.discard();
          throw error;
        }
      },
      () => {
        filesystem.discard();
        bufferedSnapshots.discard();
      },
    );
  }

  async write(input: HashlineWriteInput): Promise<PendingHashlineChange> {
    if (input.content.includes("\0")) {
      throw new HashlineWorkspaceError(`Refusing to write NUL/binary content to ${input.path}`);
    }
    const resolved = this.paths.resolveWrite(input.path);
    const filesystem = new TransactionalWorkspaceFilesystem(this.paths, this.#mutationIO);

    let exists: boolean;
    let beforeRaw = "";
    try {
      exists = await filesystem.exists(resolved.canonicalPath);
      if (exists) beforeRaw = await filesystem.readText(resolved.canonicalPath);
    } catch (error) {
      filesystem.discard();
      throw new HashlineWorkspaceError(compactError(error), { cause: error });
    }

    if (input.mode === "create" && exists) {
      filesystem.discard();
      throw new HashlineWorkspaceError(
        `${resolved.displayPath} already exists; use mode "replace" for an explicit full replacement`,
      );
    }
    if (input.mode === "replace" && !exists) {
      filesystem.discard();
      throw new HashlineWorkspaceError(
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
      filesystem.discard();
      throw new HashlineWorkspaceError(`Replacement of ${resolved.displayPath} makes no changes`);
    }

    try {
      await filesystem.writeText(resolved.canonicalPath, persisted);
    } catch (error) {
      filesystem.discard();
      throw new HashlineWorkspaceError(compactError(error), { cause: error });
    }

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
    try {
      enforcePreviewBound(diff, input.maxPreviewBytes, this.#maxPreviewBytes);
    } catch (error) {
      filesystem.discard();
      throw error;
    }
    const preview: HashlineChangePreview = { kind: "write", diff, files: [changedFile] };

    return new PendingHashlineChange(
      preview,
      async () => {
        await filesystem.publish();
        this.snapshots.record(resolved.canonicalPath, after);
      },
      () => filesystem.discard(),
    );
  }

  private async readSource(input: HashlineReadInput): Promise<{
    bytes: Uint8Array;
    canonicalPath: string;
    displayPath: string;
  }> {
    if (input.path.startsWith("artifact://")) {
      if (!this.#artifactReader) {
        throw new HashlineWorkspaceError("No artifact reader is configured");
      }
      try {
        const bytes = await this.#artifactReader.read(input.path);
        return {
          bytes: Uint8Array.from(bytes),
          canonicalPath: input.path,
          displayPath: input.path,
        };
      } catch (error) {
        throw new HashlineWorkspaceError(
          `Cannot read artifact ${input.path}: ${compactError(error)}`,
          { cause: error },
        );
      }
    }

    const resolved = this.paths.resolveRead(
      input.path,
      input.readOutsideWorkspace === undefined
        ? {}
        : { readOutsideWorkspace: input.readOutsideWorkspace },
    );
    try {
      return {
        bytes: Uint8Array.from(await readFile(resolved.canonicalPath)),
        canonicalPath: resolved.canonicalPath,
        displayPath: resolved.displayPath,
      };
    } catch (error) {
      throw new HashlineWorkspaceError(
        `Cannot read ${resolved.displayPath}: ${compactError(error)}`,
        { cause: error },
      );
    }
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
      if (section.op !== "noop") diffs.push(unifiedDiff(oldName, newName, section.before, after));
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
}

export class HashlineWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HashlineWorkspaceError";
  }
}

interface VirtualFileState {
  readonly originalBytes: Uint8Array | undefined;
  readonly originalMode: number | undefined;
  currentBytes: Uint8Array | undefined;
  currentMode: number | undefined;
}

class TransactionalWorkspaceFilesystem extends Filesystem {
  readonly #paths: WorkspacePaths;
  readonly #mutationIO: WorkspaceMutationIO;
  readonly #states = new Map<string, VirtualFileState>();
  readonly #touched = new Set<string>();
  readonly #createdDirectories: string[] = [];
  #closed = false;

  constructor(paths: WorkspacePaths, mutationIO: WorkspaceMutationIO) {
    super();
    this.#paths = paths;
    this.#mutationIO = mutationIO;
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
    this.assertOpen();
    if (content.includes("\0"))
      throw new Error(`Refusing to write NUL/binary content to ${authoredPath}`);
    const resolved = this.#paths.resolveWrite(authoredPath);
    const state = await this.load(resolved);
    state.currentBytes = encodeUtf8(content, resolved.displayPath);
    this.#touched.add(resolved.canonicalPath);
    return { text: content };
  }

  override async delete(authoredPath: string): Promise<void> {
    this.assertOpen();
    const resolved = this.#paths.resolveWrite(authoredPath, { operation: "delete" });
    const state = await this.load(resolved);
    if (state.currentBytes === undefined) throw new NotFoundError(authoredPath);
    state.currentBytes = undefined;
    this.#touched.add(resolved.canonicalPath);
  }

  override async move(from: string, to: string, content?: string): Promise<void> {
    this.assertOpen();
    const source = this.#paths.resolveWrite(from);
    const destination = this.#paths.resolveWrite(to);
    if (source.canonicalPath === destination.canonicalPath) {
      throw new Error(`Move destination is the same as ${source.displayPath}`);
    }
    const sourceState = await this.load(source);
    const destinationState = await this.load(destination);
    if (sourceState.currentBytes === undefined) throw new NotFoundError(from);
    if (content?.includes("\0")) throw new Error(`Refusing to write NUL/binary content to ${to}`);
    destinationState.currentBytes =
      content === undefined
        ? Uint8Array.from(sourceState.currentBytes)
        : encodeUtf8(content, destination.displayPath);
    destinationState.currentMode = sourceState.currentMode;
    sourceState.currentBytes = undefined;
    this.#touched.add(destination.canonicalPath);
    this.#touched.add(source.canonicalPath);
  }

  async publish(): Promise<void> {
    this.assertOpen();
    this.#closed = true;
    await this.assertNoDrift();

    const attempted: string[] = [];
    try {
      for (const canonicalPath of this.#touched) {
        const state = this.#states.get(canonicalPath);
        if (!state || bytesEqual(state.originalBytes, state.currentBytes)) continue;
        this.#paths.revalidateWrite(canonicalPath);
        attempted.push(canonicalPath);
        if (state.currentBytes === undefined) {
          await this.#mutationIO.removeFile(canonicalPath);
        } else {
          await this.ensureParent(canonicalPath);
          this.#paths.revalidateWrite(canonicalPath);
          await this.#mutationIO.writeFile(canonicalPath, state.currentBytes, state.currentMode);
        }
      }
    } catch (error) {
      const rollbackErrors = await this.rollback(attempted);
      const suffix =
        rollbackErrors.length === 0
          ? ""
          : ` Rollback also failed: ${rollbackErrors.map(compactError).join("; ")}`;
      throw new HashlineWorkspaceError(
        `Workspace publish failed: ${compactError(error)}.${suffix}`,
        {
          cause: error,
        },
      );
    }
  }

  discard(): void {
    this.#closed = true;
    this.#states.clear();
    this.#touched.clear();
  }

  private async load(resolved: ResolvedWorkspacePath): Promise<VirtualFileState> {
    const existing = this.#states.get(resolved.canonicalPath);
    if (existing) return existing;
    this.assertOpen();
    const disk = await readDiskState(resolved.canonicalPath);
    if (disk.bytes !== undefined) decodeUtf8(disk.bytes, resolved.displayPath);
    const loaded: VirtualFileState = {
      originalBytes: disk.bytes,
      originalMode: disk.mode,
      currentBytes: disk.bytes === undefined ? undefined : Uint8Array.from(disk.bytes),
      currentMode: disk.mode,
    };
    this.#states.set(resolved.canonicalPath, loaded);
    return loaded;
  }

  private async assertNoDrift(): Promise<void> {
    for (const [canonicalPath, state] of this.#states) {
      this.#paths.revalidateWrite(canonicalPath);
      const live = await readDiskState(canonicalPath);
      if (!bytesEqual(state.originalBytes, live.bytes)) {
        throw new HashlineWorkspaceError(
          `${this.#paths.display(canonicalPath)} changed between preview and commit; discard and retry`,
        );
      }
    }
  }

  private async ensureParent(filePath: string): Promise<void> {
    const parent = path.dirname(filePath);
    const relative = path.relative(this.#paths.root, parent);
    if (relative === "") return;
    let current = this.#paths.root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      let created = false;
      try {
        await mkdir(current);
        created = true;
        this.#createdDirectories.push(current);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      const metadata = await stat(current);
      if (!metadata.isDirectory()) throw new Error(`Parent path is not a directory: ${current}`);
      const resolved = this.#paths.resolveRead(current);
      if (resolved.canonicalPath !== current) {
        throw new Error(`Parent path changed through a symlink: ${current}`);
      }
      if (created) this.#paths.resolveRead(current);
    }
  }

  private async rollback(attempted: readonly string[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const canonicalPath of [...attempted].reverse()) {
      const original = this.#states.get(canonicalPath);
      if (!original) continue;
      try {
        if (original.originalBytes === undefined) {
          try {
            await this.#mutationIO.removeFile(canonicalPath);
          } catch (error) {
            if (!hasErrorCode(error, "ENOENT")) throw error;
          }
        } else {
          await this.ensureParent(canonicalPath);
          await this.#mutationIO.writeFile(
            canonicalPath,
            original.originalBytes,
            original.originalMode,
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    for (const directory of [...this.#createdDirectories].reverse()) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) errors.push(error);
      }
    }
    return errors;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Filesystem transaction is closed");
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
    this.#closed = true;
    this.#operations.length = 0;
    this.#overlay.clear();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Snapshot transaction is closed");
  }
}

class AtomicWorkspaceMutationIO implements WorkspaceMutationIO {
  async writeFile(filePath: string, bytes: Uint8Array, mode?: number): Promise<void> {
    const temporary = path.join(
      path.dirname(filePath),
      `.brisk-${process.pid}-${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", mode ?? 0o666);
      await handle.writeFile(bytes);
      if (mode !== undefined) await handle.chmod(mode & 0o7777);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeFile(filePath: string): Promise<void> {
    await rm(filePath);
  }
}

async function readDiskState(
  canonicalPath: string,
): Promise<{ bytes: Uint8Array | undefined; mode: number | undefined }> {
  try {
    const [bytes, metadata] = await Promise.all([readFile(canonicalPath), stat(canonicalPath)]);
    if (!metadata.isFile()) throw new Error(`Not a regular file: ${canonicalPath}`);
    return { bytes: Uint8Array.from(bytes), mode: metadata.mode };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { bytes: undefined, mode: undefined };
    throw error;
  }
}

function decodeUtf8(bytes: Uint8Array, displayPath: string): string {
  if (bytes.includes(0)) {
    throw new HashlineWorkspaceError(`Refusing to read NUL/binary file: ${displayPath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new HashlineWorkspaceError(`File is not valid UTF-8: ${displayPath}`, { cause: error });
  }
}

function encodeUtf8(text: string, displayPath: string): Uint8Array {
  const bytes = UTF8_ENCODER.encode(text);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== text) {
    throw new HashlineWorkspaceError(`Text contains an unpaired Unicode surrogate: ${displayPath}`);
  }
  return bytes;
}

function selectLines(
  ranges: readonly ReadLineRange[] | undefined,
  totalLines: number,
  displayPath: string,
): number[] {
  if (ranges === undefined) return Array.from({ length: totalLines }, (_, index) => index + 1);
  if (ranges.length === 0) throw new HashlineWorkspaceError("At least one line range is required");
  const selected = new Set<number>();
  for (const range of ranges) {
    const end = range.end ?? range.start;
    if (!Number.isSafeInteger(range.start) || range.start < 1) {
      throw new HashlineWorkspaceError(
        `Range start must be a positive safe integer; got ${range.start}`,
      );
    }
    if (!Number.isSafeInteger(end) || end < range.start) {
      throw new HashlineWorkspaceError(`Invalid line range ${range.start}-${end}`);
    }
    if (range.start > totalLines) {
      throw new HashlineWorkspaceError(
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

function enforcePreviewBound(diff: string, requested: number | undefined, fallback: number): void {
  const limit = positiveBound(requested, fallback, "preview");
  const size = UTF8_ENCODER.encode(diff).byteLength;
  if (size > limit) {
    throw new HashlineWorkspaceError(
      `Unified diff preview is ${size} bytes; maximum is ${limit}. Split the change into smaller operations.`,
    );
  }
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound < 1) {
    throw new RangeError(`Maximum ${label} bytes must be a positive safe integer`);
  }
  return bound;
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
