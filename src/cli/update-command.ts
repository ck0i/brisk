import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  compareVersions,
  fetchLatestRelease,
  type BriskRelease,
  type ReleaseAsset,
} from "../update/releases.ts";

const RELEASE_CHECKSUMS = "brisk-release-SHA256SUMS";
const PACKAGE_NAME = "brisk-ai";

type ReleaseTarget =
  | "brisk-linux-x64"
  | "brisk-linux-arm64"
  | "brisk-darwin-x64"
  | "brisk-darwin-arm64"
  | "brisk-windows-x64";

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly version: string;
  readonly target: string;
  readonly executable: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}

export async function runUpdateCommand(currentVersion: string): Promise<void> {
  process.stdout.write("Checking for Brisk updates...\n");
  const release = await fetchLatestRelease();
  if (compareVersions(release.version, currentVersion) <= 0) {
    process.stdout.write(`Brisk ${currentVersion} is current.\n`);
    return;
  }

  const executableDirectory = dirname(process.execPath);
  const installedManifest = join(executableDirectory, "manifest.json");
  if (await Bun.file(installedManifest).exists()) {
    await updateStandalone(release, executableDirectory, installedManifest);
    return;
  }

  const executableName = basename(process.execPath).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    await updatePackage(release.version);
    return;
  }

  throw new Error(
    "This standalone executable is missing its manifest.json. Install a complete Brisk release directory before using `brisk update`.",
  );
}

export function releaseTargetFor(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReleaseTarget {
  const platformName = platform === "win32" ? "windows" : platform;
  const candidate = `brisk-${platformName}-${architecture}`;
  if (
    candidate === "brisk-linux-x64" ||
    candidate === "brisk-linux-arm64" ||
    candidate === "brisk-darwin-x64" ||
    candidate === "brisk-darwin-arm64" ||
    candidate === "brisk-windows-x64"
  ) {
    return candidate;
  }
  throw new Error(`Brisk does not publish updates for ${platform}-${architecture}`);
}

async function updatePackage(version: string): Promise<void> {
  process.stdout.write(`Updating the global ${PACKAGE_NAME} package to ${version}...\n`);
  const child = Bun.spawn(
    [process.execPath, "add", "--global", "--trust", `${PACKAGE_NAME}@${version}`],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Bun package update exited with code ${exitCode}`);
  process.stdout.write(`Updated Brisk to ${version}.\n`);
}

async function updateStandalone(
  release: BriskRelease,
  installDirectory: string,
  installedManifestPath: string,
): Promise<void> {
  const target = releaseTargetFor();
  const archive = requireAsset(release, `${target}.tar.gz`);
  const checksums = requireAsset(release, RELEASE_CHECKSUMS);
  await validateInstalledManifest(installedManifestPath, target);

  const parentDirectory = dirname(installDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(parentDirectory, ".brisk-update-"));
  let preserveTemporaryRoot = false;
  try {
    const archivePath = join(temporaryRoot, archive.name);
    const checksumsPath = join(temporaryRoot, checksums.name);
    process.stdout.write(`Downloading Brisk ${release.version} for ${target}...\n`);
    await Promise.all([
      downloadAsset(archive, archivePath),
      downloadAsset(checksums, checksumsPath),
    ]);
    await verifyArchiveChecksum(archivePath, archive.name, checksumsPath);

    const extractionRoot = join(temporaryRoot, "release");
    await mkdir(extractionRoot);
    await validateArchiveEntries(archivePath, target);
    await runProcess(["tar", "-xzf", archivePath, "-C", extractionRoot], "extract release");
    const stagedDirectory = join(extractionRoot, target);
    await validateStagedRelease(stagedDirectory, release.version, target);

    if (process.platform === "win32") {
      scheduleWindowsReplacement(installDirectory, stagedDirectory, temporaryRoot);
      preserveTemporaryRoot = true;
      process.stdout.write(
        `Brisk ${release.version} is ready and will finish installing after this process exits.\n`,
      );
      return;
    }

    await replaceReleaseDirectory(installDirectory, stagedDirectory);
    process.stdout.write(`Updated Brisk to ${release.version}.\n`);
  } finally {
    if (!preserveTemporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function requireAsset(release: BriskRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Brisk ${release.version} is missing release asset ${name}`);
  return asset;
}

async function downloadAsset(asset: ReleaseAsset, destination: string): Promise<void> {
  const response = await fetch(asset.url, {
    headers: { "User-Agent": "brisk-updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Download of ${asset.name} failed with HTTP ${response.status}`);
  validateDownloadUrl(response.url);
  const written = await Bun.write(destination, response);
  if (written !== asset.size) {
    throw new Error(`Download of ${asset.name} was ${written} bytes; expected ${asset.size}`);
  }
}

function validateDownloadUrl(value: string): void {
  const url = new URL(value);
  const trustedHost =
    url.hostname === "github.com" ||
    url.hostname.endsWith(".github.com") ||
    url.hostname === "githubusercontent.com" ||
    url.hostname.endsWith(".githubusercontent.com");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new Error("GitHub redirected a release download to an untrusted URL");
  }
}

async function verifyArchiveChecksum(
  archivePath: string,
  archiveName: string,
  checksumsPath: string,
): Promise<void> {
  const document = await readFile(checksumsPath, "utf8");
  const checksums = new Map<string, string>();
  for (const line of document.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Release checksum file is malformed");
    if (checksums.has(match[2])) throw new Error(`Duplicate checksum for ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  const expected = checksums.get(archiveName);
  if (!expected) throw new Error(`Release checksum file does not cover ${archiveName}`);
  const actual = await sha256File(archivePath);
  if (actual !== expected) throw new Error(`Checksum verification failed for ${archiveName}`);
}

async function validateArchiveEntries(archivePath: string, target: ReleaseTarget): Promise<void> {
  const listing = await runProcess(["tar", "-tzf", archivePath], "inspect release archive", true);
  if (listing.length > 4 * 1024 * 1024)
    throw new Error("Release archive contains too many entries");
  const entries = listing.trimEnd().split(/\r?\n/);
  if (entries.length === 0) throw new Error("Release archive is empty");
  for (const entry of entries) {
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const parts = normalized.split("/");
    if (
      normalized.length === 0 ||
      normalized.includes("\\") ||
      hasControlCharacter(normalized) ||
      parts[0] !== target ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Release archive contains unsafe entry ${JSON.stringify(entry)}`);
    }
  }
}

async function validateInstalledManifest(path: string, target: ReleaseTarget): Promise<void> {
  const manifest = parseManifest(await Bun.file(path).json());
  const legacyTarget = target.replace(/^brisk-/, "bun-");
  const managedDirectoryNames = new Set([
    target,
    `${PACKAGE_NAME}-${manifest.version}-${target}`,
    `${PACKAGE_NAME}-${manifest.version}-${legacyTarget}`,
  ]);
  if (
    manifest.package !== PACKAGE_NAME ||
    (manifest.target !== target && manifest.target !== legacyTarget) ||
    manifest.executable !== basename(process.execPath) ||
    !managedDirectoryNames.has(basename(dirname(path)))
  ) {
    throw new Error(
      "The current executable is not in its own managed Brisk release directory; refusing to replace a shared directory",
    );
  }
}

async function validateStagedRelease(
  directory: string,
  version: string,
  target: ReleaseTarget,
): Promise<void> {
  const manifestPath = join(directory, "manifest.json");
  const manifest = parseManifest(await Bun.file(manifestPath).json());
  const expectedExecutable = process.platform === "win32" ? "brisk.exe" : "brisk";
  if (
    manifest.package !== PACKAGE_NAME ||
    manifest.version !== version ||
    manifest.target !== target ||
    manifest.executable !== expectedExecutable
  ) {
    throw new Error("Downloaded release manifest does not match this Brisk update");
  }
  if (manifest.artifacts.length === 0 || manifest.artifacts.length > 10_000) {
    throw new Error("Downloaded release manifest has an invalid artifact count");
  }

  const paths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    validateRelativePath(artifact.path);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || paths.has(artifact.path)) {
      throw new Error("Downloaded release manifest contains invalid artifacts");
    }
    paths.add(artifact.path);
    const artifactPath = join(directory, ...artifact.path.split("/"));
    const details = await lstat(artifactPath);
    if (!details.isFile()) throw new Error(`Release artifact is not a file: ${artifact.path}`);
    if ((await sha256File(artifactPath)) !== artifact.sha256) {
      throw new Error(`Release artifact checksum failed: ${artifact.path}`);
    }
  }
  if (!paths.has(expectedExecutable))
    throw new Error("Downloaded release is missing its executable");
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("Brisk release manifest is malformed");
  }
  const packageName = requireManifestString(value.package, "package");
  const version = requireManifestString(value.version, "version");
  const target = requireManifestString(value.target, "target");
  const executable = requireManifestString(value.executable, "executable");
  const artifacts = value.artifacts.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Brisk release manifest artifact is malformed");
    return {
      path: requireManifestString(candidate.path, "artifact path"),
      sha256: requireManifestString(candidate.sha256, "artifact sha256"),
    };
  });
  return { schemaVersion: 1, package: packageName, version, target, executable, artifacts };
}

function requireManifestString(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Brisk release manifest ${description} is invalid`);
  }
  return value;
}

function validateRelativePath(value: string): void {
  const parts = value.split("/");
  if (
    value.includes("\\") ||
    hasControlCharacter(value) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Brisk release manifest contains unsafe path ${JSON.stringify(value)}`);
  }
}

async function replaceReleaseDirectory(
  installDirectory: string,
  stagedDirectory: string,
): Promise<void> {
  const backupDirectory = `${installDirectory}.previous-${process.pid}`;
  await rm(backupDirectory, { recursive: true, force: true });
  await rename(installDirectory, backupDirectory);
  try {
    await rename(stagedDirectory, installDirectory);
  } catch (error) {
    await rename(backupDirectory, installDirectory).catch(() => undefined);
    throw error;
  }
  await rm(backupDirectory, { recursive: true, force: true });
}

function scheduleWindowsReplacement(
  installDirectory: string,
  stagedDirectory: string,
  temporaryRoot: string,
): void {
  const backupDirectory = `${installDirectory}.previous-${process.pid}`;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Wait-Process -Id ([int]$env:BRISK_UPDATE_PID) -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:BRISK_UPDATE_BACKUP -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $env:BRISK_UPDATE_INSTALL -Destination $env:BRISK_UPDATE_BACKUP
try {
  Move-Item -LiteralPath $env:BRISK_UPDATE_STAGED -Destination $env:BRISK_UPDATE_INSTALL
  Remove-Item -LiteralPath $env:BRISK_UPDATE_BACKUP -Recurse -Force
  Remove-Item -LiteralPath $env:BRISK_UPDATE_TEMP -Recurse -Force
} catch {
  Move-Item -LiteralPath $env:BRISK_UPDATE_BACKUP -Destination $env:BRISK_UPDATE_INSTALL -ErrorAction SilentlyContinue
  throw
}
`;
  const executable = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = Bun.spawn(
    [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      cwd: dirname(installDirectory),
      env: {
        ...process.env,
        BRISK_UPDATE_PID: String(process.pid),
        BRISK_UPDATE_INSTALL: installDirectory,
        BRISK_UPDATE_STAGED: stagedDirectory,
        BRISK_UPDATE_BACKUP: backupDirectory,
        BRISK_UPDATE_TEMP: temporaryRoot,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
  child.unref();
}

async function runProcess(
  command: readonly string[],
  description: string,
  captureStdout = false,
): Promise<string> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${description} failed with code ${exitCode}: ${stderr.trim() || "unknown error"}`,
    );
  }
  if (!captureStdout && stdout.trim()) process.stdout.write(stdout);
  return stdout;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
