import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, posix, win32 } from "node:path";

const MARKER_START = "# >>> brisk PATH >>>";
const MARKER_END = "# <<< brisk PATH <<<";

export interface PackageInstallContext {
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface PathInstallResult {
  readonly status: "updated" | "unchanged";
  readonly binDirectory: string;
  readonly locations: readonly string[];
}

interface PosixProfile {
  readonly path: string;
  readonly shell: "posix" | "fish";
}

export function globalBinForPackageInstall(context: PackageInstallContext): string | undefined {
  const path = context.platform === "win32" ? win32 : posix;
  const bunRoot = context.env.BUN_INSTALL?.trim() || path.join(context.home, ".bun");
  const bunGlobalModules = path.join(bunRoot, "install", "global", "node_modules");
  if (isWithin(context.cwd, bunGlobalModules, context.platform)) {
    return path.join(bunRoot, "bin");
  }

  const prefix = context.env.npm_config_prefix?.trim();
  const globalInstall = /^(?:1|true)$/i.test(context.env.npm_config_global?.trim() ?? "");
  if (!globalInstall && prefix) {
    const moduleRoots =
      context.platform === "win32"
        ? [path.join(prefix, "node_modules")]
        : [path.join(prefix, "lib", "node_modules")];
    if (moduleRoots.some((root) => isWithin(context.cwd, root, context.platform))) {
      return context.platform === "win32" ? prefix : path.join(prefix, "bin");
    }
  }

  if (!globalInstall) return undefined;

  const configuredBin = context.env.npm_config_global_bin_dir?.trim();
  if (configuredBin) return path.resolve(configuredBin);

  const userAgent = context.env.npm_config_user_agent?.toLowerCase() ?? "";
  const execPath = context.env.npm_execpath?.toLowerCase() ?? "";
  if (userAgent.startsWith("bun/") || basename(execPath).startsWith("bun")) {
    return path.join(bunRoot, "bin");
  }

  const pnpmHome = context.env.PNPM_HOME?.trim();
  if (pnpmHome && userAgent.startsWith("pnpm/")) return path.resolve(pnpmHome);
  if (prefix) return context.platform === "win32" ? prefix : path.join(prefix, "bin");
  return undefined;
}

export function pathContains(
  pathValue: string | undefined,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const delimiter = platform === "win32" ? ";" : ":";
  const normalizedTarget = normalizePathEntry(target, platform);
  return (pathValue ?? "")
    .split(delimiter)
    .some((entry) => normalizePathEntry(entry, platform) === normalizedTarget);
}

export function posixProfiles(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly PosixProfile[] {
  const shell = basename(env.SHELL ?? "").toLowerCase();
  if (shell === "fish") {
    const configHome = env.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config");
    return [{ path: posix.join(configHome, "fish", "conf.d", "brisk-path.fish"), shell: "fish" }];
  }
  if (shell === "zsh") {
    const zshHome = env.ZDOTDIR?.trim() || home;
    return [
      { path: posix.join(zshHome, ".zprofile"), shell: "posix" },
      { path: posix.join(zshHome, ".zshrc"), shell: "posix" },
    ];
  }
  if (shell === "bash") {
    return [
      {
        path: posix.join(home, platform === "darwin" ? ".bash_profile" : ".profile"),
        shell: "posix",
      },
      { path: posix.join(home, ".bashrc"), shell: "posix" },
    ];
  }
  return [{ path: posix.join(home, ".profile"), shell: "posix" }];
}

export async function ensureUserPath(
  binDirectory: string,
  context: PackageInstallContext,
  windowsWriter: (
    target: string,
    env: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<"updated" | "unchanged"> = writeWindowsUserPath,
): Promise<PathInstallResult> {
  validatePathEntry(binDirectory, context.platform);
  if (context.platform === "win32") {
    const status = await windowsWriter(binDirectory, context.env);
    return { status, binDirectory, locations: ["Windows user PATH"] };
  }
  if (context.platform !== "linux" && context.platform !== "darwin") {
    throw new Error(`unsupported platform ${context.platform}`);
  }
  if (pathContains(context.env.PATH, binDirectory, context.platform)) {
    return { status: "unchanged", binDirectory, locations: [] };
  }

  const profiles = posixProfiles(context.platform, context.home, context.env);
  let changed = false;
  for (const profile of profiles) {
    const block = renderProfileBlock(binDirectory, profile.shell);
    changed = (await upsertManagedBlock(profile.path, block)) || changed;
  }
  return {
    status: changed ? "updated" : "unchanged",
    binDirectory,
    locations: profiles.map((profile) => profile.path),
  };
}

export function renderProfileBlock(binDirectory: string, shell: "posix" | "fish"): string {
  const quoted = quoteShellWord(binDirectory);
  const lines =
    shell === "fish"
      ? [
          MARKER_START,
          `if not contains -- ${quoted} $PATH`,
          `  set -gx PATH ${quoted} $PATH`,
          "end",
          MARKER_END,
        ]
      : [
          MARKER_START,
          'case ":${PATH}:" in',
          `  *:${quoted}:*) ;;`,
          `  *) export PATH=${quoted}:"\${PATH}" ;;`,
          "esac",
          MARKER_END,
        ];
  return lines.join("\n");
}

async function upsertManagedBlock(profilePath: string, block: string): Promise<boolean> {
  let current: string;
  try {
    current = await readFile(profilePath, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    current = "";
  }

  const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
  const rendered = block.replaceAll("\n", lineEnding);
  const start = current.indexOf(MARKER_START);
  let next: string;
  if (start === -1) {
    const separator =
      current.length === 0
        ? ""
        : current.endsWith(lineEnding)
          ? lineEnding
          : `${lineEnding}${lineEnding}`;
    next = `${current}${separator}${rendered}${lineEnding}`;
  } else {
    const end = current.indexOf(MARKER_END, start + MARKER_START.length);
    if (end === -1 || current.indexOf(MARKER_START, start + MARKER_START.length) !== -1) {
      throw new Error(`cannot update malformed Brisk PATH block in ${profilePath}`);
    }
    next = `${current.slice(0, start)}${rendered}${current.slice(end + MARKER_END.length)}`;
  }

  if (next === current) return false;
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, next, "utf8");
  return true;
}

async function writeWindowsUserPath(
  target: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<"updated" | "unchanged"> {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:BRISK_PATH_ENTRY
function Has-PathEntry([string]$value, [string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  $right = [Environment]::ExpandEnvironmentVariables($candidate).TrimEnd([char]92)
  foreach ($entry in ($value -split ';')) {
    $left = [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd([char]92)
    if ($left.Equals($right, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}
$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((Has-PathEntry $machine $target) -or (Has-PathEntry $user $target)) {
  [Console]::Out.Write('unchanged')
  exit 0
}
$next = if ([string]::IsNullOrWhiteSpace($user)) { $target } else { $user.TrimEnd(';') + ';' + $target }
[Environment]::SetEnvironmentVariable('Path', $next, 'User')
[Console]::Out.Write('updated')
`;
  const executable = env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const child = Bun.spawn(
    [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, BRISK_PATH_ENTRY: target },
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`PowerShell exited with ${exitCode}: ${stderr.trim() || "unknown error"}`);
  }
  const status = stdout.trim();
  if (status !== "updated" && status !== "unchanged") {
    throw new Error(`PowerShell returned an unexpected result: ${JSON.stringify(status)}`);
  }
  return status;
}

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  let entry = value.trim();
  if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
  entry = path.normalize(entry);
  const root = path.parse(entry).root;
  while (entry.length > root.length && (entry.endsWith("/") || entry.endsWith("\\"))) {
    entry = entry.slice(0, -1);
  }
  return platform === "win32" ? entry.toLowerCase() : entry;
}

function isWithin(candidate: string, parent: string, platform: NodeJS.Platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const normalizedCandidate = normalizePathEntry(path.resolve(candidate), platform);
  const normalizedParent = normalizePathEntry(path.resolve(parent), platform);
  const prefix = normalizedParent.endsWith(path.sep)
    ? normalizedParent
    : `${normalizedParent}${path.sep}`;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(prefix);
}

function validatePathEntry(value: string, platform: NodeJS.Platform): void {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("global binary directory is not a valid PATH entry");
  }
  if (platform === "win32" ? value.includes(";") : value.includes(":")) {
    throw new Error("global binary directory contains the PATH delimiter");
  }
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function main(): Promise<void> {
  if (!process.argv.slice(2).includes("--package-install")) {
    throw new Error("this script is only intended for the brisk-ai package installer");
  }
  const context: PackageInstallContext = {
    platform: process.platform,
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
  };
  const binDirectory = globalBinForPackageInstall(context);
  if (!binDirectory) return;

  const result = await ensureUserPath(binDirectory, context);
  if (result.status === "updated") {
    const locations = result.locations.length > 0 ? ` via ${result.locations.join(", ")}` : "";
    process.stdout.write(
      `brisk: added ${result.binDirectory} to PATH${locations}. Open a new terminal to use brisk.\n`,
    );
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `brisk: installed, but PATH could not be updated automatically: ${message}\n`,
    );
  });
}
