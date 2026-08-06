import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const SUPPORTED_TARGETS = [
  "brisk-linux-x64",
  "brisk-linux-arm64",
  "brisk-darwin-x64",
  "brisk-darwin-arm64",
  "brisk-windows-x64",
] as const;

type SupportedTarget = (typeof SUPPORTED_TARGETS)[number];

interface TargetDescriptor {
  readonly bunTarget:
    "bun-linux-x64" | "bun-linux-arm64" | "bun-darwin-x64" | "bun-darwin-arm64" | "bun-windows-x64";
  readonly platform: "linux" | "darwin" | "win32";
  readonly installOs: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
  readonly executable: "brisk" | "brisk.exe";
  readonly openTuiLibrary: "libopentui.so" | "libopentui.dylib" | "opentui.dll";
}

const TARGET_DESCRIPTORS: Readonly<Record<SupportedTarget, TargetDescriptor>> = {
  "brisk-linux-x64": {
    bunTarget: "bun-linux-x64",
    platform: "linux",
    installOs: "linux",
    arch: "x64",
    executable: "brisk",
    openTuiLibrary: "libopentui.so",
  },
  "brisk-linux-arm64": {
    bunTarget: "bun-linux-arm64",
    platform: "linux",
    installOs: "linux",
    arch: "arm64",
    executable: "brisk",
    openTuiLibrary: "libopentui.so",
  },
  "brisk-darwin-x64": {
    bunTarget: "bun-darwin-x64",
    platform: "darwin",
    installOs: "darwin",
    arch: "x64",
    executable: "brisk",
    openTuiLibrary: "libopentui.dylib",
  },
  "brisk-darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    platform: "darwin",
    installOs: "darwin",
    arch: "arm64",
    executable: "brisk",
    openTuiLibrary: "libopentui.dylib",
  },
  "brisk-windows-x64": {
    bunTarget: "bun-windows-x64",
    platform: "win32",
    installOs: "win32",
    arch: "x64",
    executable: "brisk.exe",
    openTuiLibrary: "opentui.dll",
  },
};

function openTuiNativePackages(descriptor: TargetDescriptor): readonly string[] {
  const base = `@opentui/core-${descriptor.platform}-${descriptor.arch}`;
  return descriptor.platform === "linux" ? [base, `${base}-musl`] : [base];
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

interface ArtifactRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly version: string;
  readonly target: SupportedTarget;
  readonly executable: string;
  readonly artifacts: readonly ArtifactRecord[];
}

interface BuildOptions {
  readonly targets: readonly SupportedTarget[];
  readonly verify: boolean;
  readonly help: boolean;
}

const DOCUMENTS = [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/CONFIGURATION.md",
  "docs/EXTENSIONS.md",
  "docs/MCP.md",
  "docs/PROVIDERS.md",
  "docs/TROUBLESHOOTING.md",
  "docs/USAGE.md",
] as const;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const metadata = await readPackageMetadata();
  const host = hostTarget();
  if (options.verify && (options.targets.length !== 1 || options.targets[0] !== host)) {
    throw new Error(`--verify requires the host target ${host} and cannot verify cross builds`);
  }

  await mkdir(DIST, { recursive: true });
  const outputs = new Map<SupportedTarget, string>();
  for (const target of options.targets) {
    const releaseDirectory = await buildTarget(metadata, target);
    outputs.set(target, releaseDirectory);
  }

  if (options.verify) {
    const releaseDirectory = outputs.get(host);
    if (!releaseDirectory) throw new Error(`Host build ${host} was not produced`);
    await verifyHostArtifact(metadata, host, releaseDirectory);
  }
}

function parseArguments(arguments_: readonly string[]): BuildOptions {
  const selected: SupportedTarget[] = [];
  let all = false;
  let verify = false;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--verify") {
      verify = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--target") {
      const target = arguments_[++index];
      if (!target) throw new Error("--target requires a value");
      selected.push(parseTarget(target));
      continue;
    }
    if (argument.startsWith("--target=")) {
      selected.push(parseTarget(argument.slice("--target=".length)));
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown build option: ${argument}`);
    selected.push(parseTarget(argument));
  }

  if (all && selected.length > 0) throw new Error("--all cannot be combined with explicit targets");
  const targets = all
    ? [...SUPPORTED_TARGETS]
    : selected.length > 0
      ? [...new Set(selected)]
      : [hostTarget()];
  return { targets, verify, help };
}

function parseTarget(value: string): SupportedTarget {
  if (isSupportedTarget(value)) return value;
  throw new Error(
    `Unsupported target ${JSON.stringify(value)}. Supported targets: ${SUPPORTED_TARGETS.join(", ")}`,
  );
}

function isSupportedTarget(value: string): value is SupportedTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(value);
}

function hostTarget(): SupportedTarget {
  const candidate = `brisk-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (isSupportedTarget(candidate)) return candidate;
  throw new Error(
    `Unsupported host ${process.platform}-${process.arch}. Use an explicit target from: ${SUPPORTED_TARGETS.join(", ")}`,
  );
}

async function readPackageMetadata(): Promise<PackageMetadata> {
  const value: unknown = await Bun.file(join(ROOT, "package.json")).json();
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("package.json must contain string name and version fields");
  }
  return { name: value.name, version: value.version };
}

async function buildTarget(metadata: PackageMetadata, target: SupportedTarget): Promise<string> {
  const descriptor = TARGET_DESCRIPTORS[target];
  const releaseDirectory = join(DIST, target);
  await rm(releaseDirectory, { recursive: true, force: true });
  await mkdir(releaseDirectory, { recursive: true });

  let nativePackageRoot: string | undefined;
  try {
    nativePackageRoot = await prepareNativePackages(descriptor);
    await copyReleaseDocuments(releaseDirectory);
    await copyRuntimeAssets(releaseDirectory, descriptor, nativePackageRoot);
    await compileExecutable(releaseDirectory, target, descriptor.executable, nativePackageRoot);
    await writeReleaseMetadata(metadata, target, descriptor.executable, releaseDirectory);
  } catch (error) {
    await rm(releaseDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (nativePackageRoot !== undefined) {
      await rm(nativePackageRoot, { recursive: true, force: true });
    }
  }

  process.stdout.write(`Built ${relative(ROOT, releaseDirectory)}\n`);
  return releaseDirectory;
}

async function prepareNativePackages(descriptor: TargetDescriptor): Promise<string | undefined> {
  const openTuiPackages = openTuiNativePackages(descriptor);
  const piNativesPackage = `@oh-my-pi/pi-natives-${descriptor.platform}-${descriptor.arch}`;
  const installedOpenTui = await Promise.all(
    openTuiPackages.map(
      async (packageName) => await packageDirectoryExists(join(ROOT, "node_modules"), packageName),
    ),
  );
  if (
    installedOpenTui.every(Boolean) &&
    (await packageDirectoryExists(join(ROOT, "node_modules"), piNativesPackage))
  ) {
    return undefined;
  }

  const openTuiVersion = await installedPackageVersion("@opentui/core");
  const piNativesVersion = await installedPackageVersion("@oh-my-pi/pi-natives");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "brisk-native-assets-"));
  await writeFile(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify({ name: "brisk-native-assets", private: true })}\n`,
  );

  try {
    await runCommand(
      [
        process.execPath,
        "install",
        "--no-save",
        "--ignore-scripts",
        `--os=${descriptor.installOs}`,
        `--cpu=${descriptor.arch}`,
        ...openTuiPackages.map((packageName) => `${packageName}@${openTuiVersion}`),
        `${piNativesPackage}@${piNativesVersion}`,
      ],
      temporaryRoot,
      `install native assets for ${descriptor.platform}-${descriptor.arch}`,
    );
    return temporaryRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installedPackageVersion(packageName: string): Promise<string> {
  const value: unknown = await Bun.file(
    join(ROOT, "node_modules", ...packageName.split("/"), "package.json"),
  ).json();
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new Error(`Cannot determine installed version of ${packageName}; run bun install first`);
  }
  return value.version;
}

async function packageDirectoryExists(nodeModules: string, packageName: string): Promise<boolean> {
  return await Bun.file(join(nodeModules, ...packageName.split("/"), "package.json")).exists();
}

async function copyReleaseDocuments(releaseDirectory: string): Promise<void> {
  for (const document of DOCUMENTS) {
    const source = join(ROOT, ...document.split("/"));
    if (!(await Bun.file(source).exists()))
      throw new Error(`Missing release document: ${document}`);
    const destination = join(releaseDirectory, ...document.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const mcpLicense = join(ROOT, "node_modules", "@modelcontextprotocol", "client", "LICENSE");
  await requirePath(mcpLicense, "MCP client license");
  const mcpLicenseDestination = join(
    releaseDirectory,
    "licenses",
    "@modelcontextprotocol-client-LICENSE",
  );
  await mkdir(dirname(mcpLicenseDestination), { recursive: true });
  await copyFile(mcpLicense, mcpLicenseDestination);
}

async function copyRuntimeAssets(
  releaseDirectory: string,
  descriptor: TargetDescriptor,
  temporaryRoot: string | undefined,
): Promise<void> {
  const assetRoot = join(releaseDirectory, "assets");
  const coreAssets = join(ROOT, "node_modules", "@opentui", "core", "assets");
  const treeSitterWasm = join(ROOT, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
  await requirePath(coreAssets, "OpenTUI parser assets");
  await requirePath(treeSitterWasm, "web-tree-sitter runtime");
  await cp(coreAssets, join(assetRoot, "@opentui", "core", "assets"), { recursive: true });
  const treeSitterDestination = join(assetRoot, "web-tree-sitter", "tree-sitter.wasm");
  await mkdir(dirname(treeSitterDestination), { recursive: true });
  await copyFile(treeSitterWasm, treeSitterDestination);

  const nodeModules = temporaryRoot
    ? join(temporaryRoot, "node_modules")
    : join(ROOT, "node_modules");
  for (const openTuiPackage of openTuiNativePackages(descriptor)) {
    const openTuiDirectory = join(nodeModules, ...openTuiPackage.split("/"));
    const openTuiLibrary = join(openTuiDirectory, descriptor.openTuiLibrary);
    await requirePath(openTuiLibrary, `${openTuiPackage} native library`);
    const openTuiDestination = join(
      assetRoot,
      ...openTuiPackage.split("/"),
      descriptor.openTuiLibrary,
    );
    await mkdir(dirname(openTuiDestination), { recursive: true });
    await copyFile(openTuiLibrary, openTuiDestination);
  }

  const piNativesPackage = `@oh-my-pi/pi-natives-${descriptor.platform}-${descriptor.arch}`;
  const piNativesDirectory = join(nodeModules, ...piNativesPackage.split("/"));
  await requirePath(piNativesDirectory, `${piNativesPackage} native addons`);
  const nativeFiles = (await readdir(piNativesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".node"))
    .map((entry) => entry.name)
    .sort();
  if (nativeFiles.length === 0) throw new Error(`${piNativesPackage} contains no .node addons`);
  for (const nativeFile of nativeFiles) {
    await copyFile(join(piNativesDirectory, nativeFile), join(releaseDirectory, nativeFile));
  }
}

async function compileExecutable(
  releaseDirectory: string,
  target: SupportedTarget,
  executableName: string,
  nativePackageRoot: string | undefined,
): Promise<void> {
  const entryPath = join(releaseDirectory, ".brisk-build-entry.ts");
  const sourcePath = join(ROOT, "src", "main.ts");
  let sourceSpecifier = relative(dirname(entryPath), sourcePath).split(sep).join("/");
  if (!sourceSpecifier.startsWith(".")) sourceSpecifier = `./${sourceSpecifier}`;
  await writeFile(
    entryPath,
    [
      'import { dirname, join } from "node:path";',
      'process.env.OTUI_ASSET_ROOT ||= join(dirname(process.execPath), "assets");',
      `await import(${JSON.stringify(sourceSpecifier)});`,
      "",
    ].join("\n"),
  );

  const executablePath = join(releaseDirectory, executableName);
  try {
    await runCommand(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-dotenv",
        `--target=${TARGET_DESCRIPTORS[target].bunTarget}`,
        `--outfile=${executablePath}`,
        entryPath,
      ],
      ROOT,
      `compile ${target}`,
      nativePackageRoot === undefined
        ? undefined
        : {
            ...process.env,
            NODE_PATH: [join(nativePackageRoot, "node_modules"), process.env.NODE_PATH]
              .filter((value): value is string => value !== undefined && value.length > 0)
              .join(delimiter),
          },
    );
    if (process.platform !== "win32") await chmod(executablePath, 0o755);
  } finally {
    await rm(entryPath, { force: true });
  }
}

async function writeReleaseMetadata(
  metadata: PackageMetadata,
  target: SupportedTarget,
  executableName: string,
  releaseDirectory: string,
): Promise<void> {
  const files = (await listFiles(releaseDirectory))
    .filter((path) => path !== "manifest.json" && path !== "SHA256SUMS")
    .sort();
  const artifacts: ArtifactRecord[] = [];
  for (const path of files) {
    const absolutePath = join(releaseDirectory, ...path.split("/"));
    const [details, sha256] = await Promise.all([stat(absolutePath), sha256File(absolutePath)]);
    artifacts.push({ path, size: details.size, sha256 });
  }

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    package: metadata.name,
    version: metadata.version,
    target,
    executable: executableName,
    artifacts,
  };
  const manifestPath = join(releaseDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksummedFiles = [...files, "manifest.json"].sort();
  const checksumLines: string[] = [];
  for (const path of checksummedFiles) {
    const hash = await sha256File(join(releaseDirectory, ...path.split("/")));
    checksumLines.push(`${hash}  ${path}`);
  }
  await writeFile(join(releaseDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
}

async function verifyHostArtifact(
  metadata: PackageMetadata,
  target: SupportedTarget,
  releaseDirectory: string,
): Promise<void> {
  const executablePath = join(releaseDirectory, TARGET_DESCRIPTORS[target].executable);
  const child = Bun.spawn([executablePath, "version"], {
    cwd: releaseDirectory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const expected = `brisk ${metadata.version}\n`;
  if (exitCode !== 0 || stdout !== expected || stderr !== "") {
    throw new Error(
      [
        `Host artifact verification failed with exit code ${exitCode}.`,
        `Expected stdout ${JSON.stringify(expected)}, got ${JSON.stringify(stdout)}.`,
        `stderr: ${JSON.stringify(stderr)}`,
      ].join(" "),
    );
  }
  process.stdout.write(`Verified ${target}: ${stdout}`);
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  description: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `${description} failed with exit code ${exitCode}${detail ? `:\n${detail}` : ""}`,
    );
  }
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(root, absolutePath)));
    else if (entry.isFile()) result.push(relative(root, absolutePath).split(sep).join("/"));
  }
  return result;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requirePath(path: string, description: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(`Missing ${description} at ${path}; run bun install first`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp(): void {
  process.stdout.write(
    [
      "Build Brisk standalone release directories.",
      "",
      "Usage:",
      "  bun scripts/build.ts [target ...]",
      "  bun scripts/build.ts --target <target> [--target <target> ...]",
      "  bun scripts/build.ts --all",
      "  bun scripts/build.ts --verify",
      "",
      `Targets: ${SUPPORTED_TARGETS.join(", ")}`,
      "",
      "No target builds the host. --verify builds the host and runs `brisk version`.",
      "",
    ].join("\n"),
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`build: ${message}\n`);
  process.exitCode = 1;
});
