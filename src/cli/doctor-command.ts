import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import packageMetadata from "../../package.json";
import type { CliCommand } from "./args.ts";
import type { ConfigPaths } from "../config/paths.ts";

export type DoctorStatus = "ok" | "warn" | "error";
export type DoctorDetailValue = string | number | boolean | null | readonly string[];

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly fix: string | null;
  readonly details: Readonly<Record<string, DoctorDetailValue>>;
}

export interface DoctorReport {
  readonly version: 1;
  readonly status: DoctorStatus;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorAuthStatusService {
  listProviderStatus(): readonly {
    readonly configured: boolean;
    readonly oauthAvailable: boolean;
  }[];
  close(): void;
}

export interface VersionProbeResult {
  readonly available: boolean;
  readonly version: string | null;
}

export interface TerminalSnapshot {
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
  readonly stderrTty: boolean;
  readonly term: string | null;
  readonly colorTerm: string | null;
  readonly noColor: boolean;
  readonly forceColor: boolean;
  readonly colorDepth: number;
}

export interface SessionIndexInspection {
  readonly source: "cache" | "rebuild";
  readonly sessionCount: number;
  readonly diagnosticCount: number;
}

export interface DoctorDependencies {
  readonly runtimeVersion?: string;
  readonly engineIntent?: string;
  readonly loadOpenTui?: () => Promise<unknown>;
  readonly probeDirectory?: (directory: string) => Promise<void>;
  readonly createAuthService?: (dbPath: string) => Promise<DoctorAuthStatusService>;
  readonly probeVersion?: (executable: "rg" | "git") => Promise<VersionProbeResult>;
  readonly terminal?: TerminalSnapshot;
  readonly inspectSessionIndex?: (paths: ConfigPaths) => Promise<SessionIndexInspection>;
}

export interface DoctorCommandOptions {
  readonly output?: NodeJS.WritableStream;
  readonly dependencies?: DoctorDependencies;
  readonly setExitCode?: (exitCode: 1) => void;
}

const extensionErrorsFilename = "errors.json";
const runtimeEngineIntent = packageMetadata.engines.bun;

/**
 * Runs non-destructive installation checks. Warnings intentionally exit zero so optional tools,
 * an empty cache, or a redirected terminal do not fail automation. Any error check sets exit 1.
 */
export async function runDoctorCommand(
  command: Extract<CliCommand, { readonly name: "doctor" }>,
  paths: ConfigPaths,
  options: DoctorCommandOptions = {},
): Promise<DoctorReport> {
  const dependencies = options.dependencies ?? {};
  const checks: DoctorCheck[] = [];

  checks.push(checkBun(dependencies.runtimeVersion ?? Bun.version, dependencies.engineIntent));
  checks.push(await checkOpenTui(dependencies.loadOpenTui));
  checks.push(
    await checkDirectory("directory.config", "configuration", paths.configRoot, dependencies),
  );
  checks.push(await checkDirectory("directory.data", "data", paths.dataRoot, dependencies));
  checks.push(await checkDirectory("directory.cache", "cache", paths.cacheRoot, dependencies));
  checks.push(await checkAuthentication(paths.authPath, dependencies));
  checks.push(await checkModelCache(paths.modelCachePath));
  checks.push(await checkExecutable("tool.rg", "ripgrep", "rg", dependencies));
  checks.push(await checkExecutable("tool.git", "Git", "git", dependencies));
  checks.push(checkTerminal(dependencies.terminal ?? currentTerminalSnapshot()));
  checks.push(await checkSessionIndex(paths, dependencies));
  checks.push(await checkExtensionErrors(join(paths.extensionsDir, extensionErrorsFilename)));

  const report: DoctorReport = { version: 1, status: overallStatus(checks), checks };
  writeReport(report, command.json, options.output ?? process.stdout);
  if (report.status === "error") {
    (options.setExitCode ?? ((exitCode) => (process.exitCode = exitCode)))(1);
  }
  return report;
}

function checkBun(runtimeVersion: string, overriddenIntent: string | undefined): DoctorCheck {
  const engineIntent = overriddenIntent ?? runtimeEngineIntent;
  const runtime = parseVersion(runtimeVersion);
  const minimum = parseEngineMinimum(engineIntent);
  if (!runtime || !minimum) {
    return makeCheck(
      "runtime.bun",
      "error",
      "Unable to validate the Bun runtime version.",
      `Install a Bun release satisfying ${runtimeEngineIntent}.`,
      { runtimeVersion: null, engineIntent: safeEngineIntent(engineIntent) },
    );
  }
  const compatible = compareVersions(runtime, minimum) >= 0;
  return makeCheck(
    "runtime.bun",
    compatible ? "ok" : "error",
    compatible
      ? `Bun ${runtime.normalized} satisfies ${engineIntent}.`
      : `Bun ${runtime.normalized} does not satisfy ${engineIntent}.`,
    compatible ? null : `Upgrade Bun to ${minimum.normalized} or newer.`,
    { runtimeVersion: runtime.normalized, engineIntent },
  );
}

async function checkOpenTui(loader: (() => Promise<unknown>) | undefined): Promise<DoctorCheck> {
  try {
    const module = await (loader ?? loadOpenTuiNative)();
    const loaded = hasFunctionProperty(module, "createCliRenderer");
    return makeCheck(
      "ui.opentui",
      loaded ? "ok" : "error",
      loaded
        ? "OpenTUI and its native runtime loaded successfully."
        : "OpenTUI loaded without its renderer entry point.",
      loaded ? null : "Reinstall Brisk for this operating system and architecture.",
      { module: "@opentui/core", loaded },
    );
  } catch {
    return makeCheck(
      "ui.opentui",
      "error",
      "OpenTUI or its native runtime could not be loaded.",
      "Reinstall Brisk for this operating system and architecture.",
      { module: "@opentui/core", loaded: false },
    );
  }
}

async function loadOpenTuiNative(): Promise<unknown> {
  const module = await import("@opentui/core");
  module.resolveRenderLib();
  return module;
}

async function checkDirectory(
  id: string,
  label: string,
  directory: string,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  try {
    await (dependencies.probeDirectory ?? probePrivateDirectory)(directory);
    return makeCheck(id, "ok", `The ${label} directory is writable.`, null, {
      directory: label,
      writable: true,
      privateProbeCleaned: true,
    });
  } catch {
    return makeCheck(
      id,
      "error",
      `The ${label} directory is not writable with a private probe.`,
      `Correct ownership and permissions for the Brisk ${label} directory.`,
      { directory: label, writable: false, privateProbeCleaned: false },
    );
  }
}

async function probePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probeDirectory = await mkdtemp(join(directory, ".brisk-doctor-"));
  try {
    if (process.platform !== "win32") await chmod(probeDirectory, 0o700);
    const probePath = join(probeDirectory, "writable");
    await writeFile(probePath, "", { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(probePath, 0o600);
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

async function checkAuthentication(
  authPath: string,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  let service: DoctorAuthStatusService | undefined;
  let statuses:
    readonly { readonly configured: boolean; readonly oauthAvailable: boolean }[] | undefined;
  let failed = false;
  try {
    service = await (dependencies.createAuthService ?? createAuthService)(authPath);
    statuses = service.listProviderStatus();
  } catch {
    failed = true;
  } finally {
    if (service) {
      try {
        service.close();
      } catch {
        failed = true;
      }
    }
  }

  if (failed || !statuses) {
    return makeCheck(
      "auth.providers",
      "error",
      "Provider credential status could not be inspected.",
      "Check access to Brisk authentication storage and retry.",
      { inspected: false, providerCount: 0, configuredCount: 0, oauthAvailableCount: 0 },
    );
  }

  const configuredCount = statuses.filter((status) => status.configured).length;
  const oauthAvailableCount = statuses.filter((status) => status.oauthAvailable).length;
  const configured = configuredCount > 0;
  return makeCheck(
    "auth.providers",
    configured ? "ok" : "warn",
    configured
      ? `${configuredCount} of ${statuses.length} provider credential entries are configured.`
      : "No provider credentials are configured.",
    configured
      ? null
      : "Run brisk auth login or configure a supported provider API-key environment variable.",
    {
      inspected: true,
      providerCount: statuses.length,
      configuredCount,
      oauthAvailableCount,
    },
  );
}

async function createAuthService(dbPath: string): Promise<DoctorAuthStatusService> {
  const { AuthService } = await import("../providers/auth-service.ts");
  return await AuthService.initialize(dbPath);
}

async function checkModelCache(cachePath: string): Promise<DoctorCheck> {
  let text: string;
  try {
    text = await readFile(cachePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return makeCheck(
        "models.cache",
        "warn",
        "The model cache does not exist yet.",
        "Run brisk models --refresh to populate the cache.",
        { exists: false, valid: false, modelCount: 0 },
      );
    }
    return makeCheck(
      "models.cache",
      "error",
      "The model cache could not be read.",
      "Correct cache directory ownership and permissions, then refresh models.",
      { exists: true, valid: false, modelCount: 0 },
    );
  }

  const modelCount = parseModelCacheCount(text);
  if (modelCount === undefined) {
    return makeCheck(
      "models.cache",
      "warn",
      "The model cache is invalid and will need to be regenerated.",
      "Run brisk models --refresh to regenerate the cache.",
      { exists: true, valid: false, modelCount: 0 },
    );
  }
  return makeCheck(
    "models.cache",
    modelCount > 0 ? "ok" : "warn",
    modelCount > 0
      ? `The model cache is valid with ${modelCount} models.`
      : "The model cache is valid but empty.",
    modelCount > 0 ? null : "Run brisk models --refresh to populate the cache.",
    { exists: true, valid: true, modelCount },
  );
}

function parseModelCacheCount(text: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.models)) return undefined;
  return value.models.every(isCachedModel) ? value.models.length : undefined;
}

function isCachedModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.api === "string" &&
    typeof value.baseUrl === "string" &&
    validTokenLimit(value.contextWindow) &&
    validTokenLimit(value.maxTokens) &&
    Array.isArray(value.input) &&
    value.input.every((input) => input === "text" || input === "image") &&
    typeof value.reasoning === "boolean" &&
    typeof value.supportsTools === "boolean" &&
    typeof value.available === "boolean" &&
    (value.source === "bundled" || value.source === "custom")
  );
}

function validTokenLimit(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

async function checkExecutable(
  id: "tool.rg" | "tool.git",
  name: string,
  executable: "rg" | "git",
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  let result: VersionProbeResult;
  try {
    result = await (dependencies.probeVersion ?? probeExecutableVersion)(executable);
  } catch {
    result = { available: false, version: null };
  }
  const version = result.version === null ? null : safeToolVersion(result.version);
  if (result.available && version) {
    return makeCheck(id, "ok", `${name} ${version} is available.`, null, {
      available: true,
      version,
    });
  }
  const missing = !result.available;
  return makeCheck(
    id,
    "warn",
    missing ? `${name} is not available on PATH.` : `${name} returned an unrecognized version.`,
    executable === "rg"
      ? "Install ripgrep and ensure rg is on PATH for faster search."
      : "Install Git and ensure git is on PATH for repository workflows.",
    { available: result.available, version: null },
  );
}

async function probeExecutableVersion(executable: "rg" | "git"): Promise<VersionProbeResult> {
  let subprocess: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    subprocess = Bun.spawn([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { available: false, version: null };
  }
  const timer = setTimeout(() => subprocess.kill(), 3_000);
  try {
    const [exitCode, output] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    if (exitCode !== 0) return { available: false, version: null };
    const pattern = executable === "rg" ? /^ripgrep (\S+)/m : /^git version (\S+)/m;
    const candidate = pattern.exec(output)?.[1];
    return {
      available: true,
      version: candidate === undefined ? null : safeToolVersion(candidate),
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkTerminal(terminal: TerminalSnapshot): DoctorCheck {
  const term = safeTerminalName(terminal.term);
  const colorTerm = safeTerminalName(terminal.colorTerm);
  const interactive = terminal.stdinTty && terminal.stdoutTty && term !== null && term !== "dumb";
  const colorDepth = safeColorDepth(terminal.colorDepth);
  return makeCheck(
    "terminal.capabilities",
    interactive ? "ok" : "warn",
    interactive
      ? "The terminal is interactive and exposes capability metadata."
      : "The terminal is redirected, non-interactive, or has limited capabilities.",
    interactive ? null : "Run brisk in an interactive terminal with TERM configured for the TUI.",
    {
      stdinTty: terminal.stdinTty,
      stdoutTty: terminal.stdoutTty,
      stderrTty: terminal.stderrTty,
      term,
      colorTerm,
      noColor: terminal.noColor,
      forceColor: terminal.forceColor,
      colorDepth,
      colorEnabled: colorDepth > 1 && !terminal.noColor,
    },
  );
}

function currentTerminalSnapshot(): TerminalSnapshot {
  const output = process.stdout as typeof process.stdout & { getColorDepth?: () => number };
  return {
    stdinTty: Boolean(process.stdin.isTTY),
    stdoutTty: Boolean(process.stdout.isTTY),
    stderrTty: Boolean(process.stderr.isTTY),
    term: process.env.TERM ?? null,
    colorTerm: process.env.COLORTERM ?? null,
    noColor: process.env.NO_COLOR !== undefined,
    forceColor: process.env.FORCE_COLOR !== undefined,
    colorDepth: output.getColorDepth?.() ?? (process.stdout.isTTY ? 4 : 1),
  };
}

async function checkSessionIndex(
  paths: ConfigPaths,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  let inspection: SessionIndexInspection;
  try {
    inspection = await (dependencies.inspectSessionIndex ?? inspectSessionIndex)(paths);
  } catch {
    return makeCheck(
      "sessions.index",
      "error",
      "The session index could not be loaded or rebuilt.",
      "Check data directory permissions and session transcript readability.",
      { source: "unavailable", sessionCount: 0, diagnosticCount: 0 },
    );
  }
  const loadedFromCache = inspection.source === "cache";
  return makeCheck(
    "sessions.index",
    loadedFromCache ? "ok" : "warn",
    loadedFromCache
      ? `The session index fast-loaded ${inspection.sessionCount} sessions.`
      : `The session index was rebuilt with ${inspection.sessionCount} sessions and ${inspection.diagnosticCount} diagnostics.`,
    loadedFromCache
      ? null
      : "Review skipped transcript diagnostics if expected sessions are missing.",
    {
      source: inspection.source,
      sessionCount: inspection.sessionCount,
      diagnosticCount: inspection.diagnosticCount,
    },
  );
}

async function inspectSessionIndex(paths: ConfigPaths): Promise<SessionIndexInspection> {
  const { SessionRepository } = await import("../sessions/repository.ts");
  const repository = new SessionRepository({
    sessionsDir: paths.sessionsDir,
    sessionIndexPath: paths.sessionIndexPath,
  });
  try {
    const sessions = await repository.list();
    const loadInfo = repository.index.loadInfo;
    if (!loadInfo) throw new Error("session index did not report load information");
    return {
      source: loadInfo.source,
      sessionCount: sessions.length,
      diagnosticCount: loadInfo.diagnostics.length,
    };
  } finally {
    await repository.close();
  }
}

async function checkExtensionErrors(errorsPath: string): Promise<DoctorCheck> {
  let text: string;
  try {
    text = await readFile(errorsPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return makeCheck(
        "extensions.errors",
        "ok",
        "No extension load error report is present.",
        null,
        { reportPresent: false, valid: true, errorCount: 0 },
      );
    }
    return makeCheck(
      "extensions.errors",
      "warn",
      "The extension load error report could not be read.",
      "Check extension directory ownership and permissions.",
      { reportPresent: true, valid: false, errorCount: 0 },
    );
  }

  const errorCount = parseExtensionErrorCount(text);
  if (errorCount === undefined) {
    return makeCheck(
      "extensions.errors",
      "warn",
      "The extension load error report is invalid.",
      "Regenerate or remove the stale extension errors.json report.",
      { reportPresent: true, valid: false, errorCount: 0 },
    );
  }
  return makeCheck(
    "extensions.errors",
    errorCount === 0 ? "ok" : "warn",
    errorCount === 0
      ? "The extension load error report contains no errors."
      : `The extension load error report contains ${errorCount} error${errorCount === 1 ? "" : "s"}.`,
    errorCount === 0 ? null : "Inspect installed extensions and resolve their load failures.",
    { reportPresent: true, valid: true, errorCount },
  );
}

function parseExtensionErrorCount(text: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) return value.length;
  if (isRecord(value) && Array.isArray(value.errors)) return value.errors.length;
  return undefined;
}

function makeCheck(
  id: string,
  status: DoctorStatus,
  message: string,
  fix: string | null,
  details: Readonly<Record<string, DoctorDetailValue>>,
): DoctorCheck {
  return { id, status, message, fix, details };
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}

function writeReport(report: DoctorReport, json: boolean, output: NodeJS.WritableStream): void {
  if (json) {
    output.write(`${JSON.stringify(report)}\n`);
    return;
  }
  output.write("Brisk doctor\n");
  for (const check of report.checks) {
    output.write(`${check.status.toUpperCase().padEnd(5)} ${check.id}: ${check.message}\n`);
    output.write(`      fix: ${check.fix ?? "none"}\n`);
    output.write(`      details: ${JSON.stringify(check.details)}\n`);
  }
  const okCount = report.checks.filter((check) => check.status === "ok").length;
  const warningCount = report.checks.filter((check) => check.status === "warn").length;
  const errorCount = report.checks.filter((check) => check.status === "error").length;
  output.write(
    `Overall: ${report.status.toUpperCase()} (${okCount} ok, ${warningCount} warnings, ${errorCount} errors)\n`,
  );
}

interface ParsedVersion {
  readonly parts: readonly [number, number, number];
  readonly normalized: string;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { parts: [major, minor, patch], normalized: `${major}.${minor}.${patch}` };
}

function parseEngineMinimum(value: string): ParsedVersion | undefined {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(value.trim());
  return match?.[1] === undefined ? undefined : parseVersion(match[1]);
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function safeEngineIntent(value: string): string {
  return /^>=\s*\d+\.\d+\.\d+$/.test(value.trim()) ? value.trim() : "invalid";
}

function safeToolVersion(value: string): string | null {
  const trimmed = value.trim();
  return /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

function safeTerminalName(value: string | null): string | null {
  if (value === null || value === "") return null;
  const normalized = value.toLowerCase();
  if (normalized === "dumb" || normalized === "truecolor" || normalized === "24bit") {
    return normalized;
  }
  const family =
    /^(xterm|screen|tmux|linux|vt\d+|ansi|rxvt|alacritty|kitty|wezterm|foot|cygwin|eterm|cons\d+)(?:[-._+][a-z0-9]+)*$/.exec(
      normalized,
    )?.[1];
  return family ?? "custom";
}

function safeColorDepth(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 24 ? value : 1;
}

function hasFunctionProperty(value: unknown, property: string): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    property in value &&
    typeof (value as Readonly<Record<string, unknown>>)[property] === "function"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
