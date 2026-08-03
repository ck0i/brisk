import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REFERENCE_PREFIX = "artifact://";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ArtifactWriteOptions {
  readonly id?: string;
  readonly name?: string;
  readonly mediaType?: string;
  readonly encoding?: "utf-8" | "binary";
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly reference: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly mediaType: string;
  readonly encoding: "utf-8" | "binary";
  readonly name?: string;
}

export class ArtifactStore {
  readonly root: string;
  private initialization: Promise<void> | undefined;

  constructor(root: string) {
    if (root.length === 0) throw new Error("Artifact directory cannot be empty");
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeRoot();
    await this.initialization;
  }

  async write(
    content: string | Uint8Array,
    options: ArtifactWriteOptions = {},
  ): Promise<ArtifactMetadata> {
    const writer = await this.createWriter({
      ...options,
      encoding: options.encoding ?? (typeof content === "string" ? "utf-8" : "binary"),
    });
    try {
      await writer.write(content);
      return await writer.commit();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  async createWriter(options: ArtifactWriteOptions = {}): Promise<ArtifactWriter> {
    await this.initialize();
    const id = options.id === undefined ? crypto.randomUUID() : validateId(options.id);
    const dataPath = this.dataPath(id);
    const metadataPath = this.metadataPath(id);
    if ((await pathExists(dataPath)) || (await pathExists(metadataPath))) {
      throw new Error(`Artifact already exists: ${REFERENCE_PREFIX}${id}`);
    }

    const temporaryPath = this.temporaryPath(id);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      FILE_MODE,
    );
    return new ArtifactWriter(this, id, temporaryPath, handle, options);
  }

  async resolve(reference: string): Promise<string> {
    await this.initialize();
    const id = parseReference(reference);
    const metadata = await this.readMetadataById(id);
    const dataPath = this.dataPath(id);
    await assertPrivateRegularFile(dataPath);
    if (metadata.reference !== reference)
      throw new Error(`Invalid artifact metadata: ${reference}`);
    return dataPath;
  }

  async metadata(reference: string): Promise<ArtifactMetadata> {
    await this.initialize();
    return await this.readMetadataById(parseReference(reference));
  }

  async read(reference: string): Promise<Uint8Array> {
    const path = await this.resolve(reference);
    return new Uint8Array(await readFile(path));
  }

  async readText(reference: string): Promise<string> {
    const metadata = await this.metadata(reference);
    if (metadata.encoding !== "utf-8") {
      throw new Error(`Artifact is not UTF-8 text: ${reference}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.read(reference));
  }

  dataPath(id: string): string {
    return resolve(this.root, `${validateId(id)}.data`);
  }

  metadataPath(id: string): string {
    return resolve(this.root, `${validateId(id)}.json`);
  }

  private temporaryPath(id: string): string {
    return resolve(this.root, `.${validateId(id)}.${crypto.randomUUID()}.tmp`);
  }

  private async initializeRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(this.root, DIRECTORY_MODE);
    const entry = await lstat(this.root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Artifact root is not a private directory: ${this.root}`);
    }
  }

  private async readMetadataById(id: string): Promise<ArtifactMetadata> {
    const path = this.metadataPath(id);
    await assertPrivateRegularFile(path);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Unknown or invalid artifact: ${REFERENCE_PREFIX}${id}`, { cause: error });
    }
    const metadata = parseMetadata(value);
    if (metadata.id !== id || metadata.reference !== `${REFERENCE_PREFIX}${id}`) {
      throw new Error(`Invalid artifact metadata: ${REFERENCE_PREFIX}${id}`);
    }
    return metadata;
  }

  async publish(
    id: string,
    temporaryPath: string,
    bytes: number,
    options: ArtifactWriteOptions,
  ): Promise<ArtifactMetadata> {
    const metadata: ArtifactMetadata = {
      id,
      reference: `${REFERENCE_PREFIX}${id}`,
      bytes,
      createdAt: new Date().toISOString(),
      mediaType: options.mediaType ?? "application/octet-stream",
      encoding: options.encoding ?? "binary",
      ...(options.name === undefined ? {} : { name: options.name }),
    };
    const dataPath = this.dataPath(id);
    const metadataPath = this.metadataPath(id);
    await rename(temporaryPath, dataPath);
    await chmod(dataPath, FILE_MODE);
    try {
      await atomicWrite(metadataPath, `${JSON.stringify(metadata)}\n`);
    } catch (error) {
      await unlink(dataPath).catch(() => undefined);
      throw error;
    }
    return metadata;
  }
}

export class ArtifactWriter {
  private bytesWritten = 0;
  private state: "open" | "committed" | "aborted" = "open";

  constructor(
    private readonly store: ArtifactStore,
    readonly id: string,
    private readonly temporaryPath: string,
    private readonly handle: FileHandle,
    private readonly options: ArtifactWriteOptions,
  ) {}

  get reference(): string {
    return `${REFERENCE_PREFIX}${this.id}`;
  }

  async write(content: string | Uint8Array): Promise<void> {
    if (this.state !== "open") throw new Error(`Artifact writer is ${this.state}`);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (bytes.byteLength === 0) return;
    await this.handle.write(bytes, 0, bytes.byteLength, null);
    this.bytesWritten += bytes.byteLength;
  }

  async commit(): Promise<ArtifactMetadata> {
    if (this.state !== "open") throw new Error(`Artifact writer is ${this.state}`);
    await this.handle.sync();
    await this.handle.close();
    try {
      const metadata = await this.store.publish(
        this.id,
        this.temporaryPath,
        this.bytesWritten,
        this.options,
      );
      this.state = "committed";
      return metadata;
    } catch (error) {
      this.state = "aborted";
      await unlink(this.temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.state !== "open") return;
    this.state = "aborted";
    await this.handle.close().catch(() => undefined);
    await unlink(this.temporaryPath).catch(() => undefined);
  }
}

export function parseArtifactReference(reference: string): string {
  return parseReference(reference);
}

function parseReference(reference: string): string {
  if (!reference.startsWith(REFERENCE_PREFIX))
    throw new Error(`Invalid artifact reference: ${reference}`);
  const id = reference.slice(REFERENCE_PREFIX.length);
  try {
    return validateId(id);
  } catch (error) {
    throw new Error(`Invalid artifact reference: ${reference}`, { cause: error });
  }
}

function validateId(id: string): string {
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`Unsafe artifact id: ${id}`);
  }
  return id;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    FILE_MODE,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, FILE_MODE);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    throw new Error(`Unknown artifact file: ${path}`, { cause: error });
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Invalid artifact file: ${path}`);
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
    throw new Error(`Artifact file has unsafe permissions: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseMetadata(value: unknown): ArtifactMetadata {
  if (!isRecord(value)) throw new Error("Artifact metadata must be an object");
  const { id, reference, bytes, createdAt, mediaType, encoding, name } = value;
  if (
    typeof id !== "string" ||
    typeof reference !== "string" ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof createdAt !== "string" ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof mediaType !== "string" ||
    (encoding !== "utf-8" && encoding !== "binary") ||
    (name !== undefined && typeof name !== "string")
  ) {
    throw new Error("Invalid artifact metadata");
  }
  validateId(id);
  return {
    id,
    reference,
    bytes,
    createdAt,
    mediaType,
    encoding,
    ...(name === undefined ? {} : { name }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
