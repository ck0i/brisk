import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type ConfigPlatform = "linux" | "darwin" | "win32";

export interface ConfigPathEnvironment {
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_DATA_HOME?: string;
  readonly XDG_CACHE_HOME?: string;
  readonly APPDATA?: string;
  readonly LOCALAPPDATA?: string;
}

/** Explicit inputs make platform path calculation deterministic in tests. */
export interface ConfigPathInput {
  readonly platform?: ConfigPlatform;
  readonly homeDir?: string;
  readonly env?: ConfigPathEnvironment;
}

export interface ConfigPaths {
  readonly platform: ConfigPlatform;
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly globalConfigPath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly authPath: string;
  readonly modelCachePath: string;
  readonly sessionIndexPath: string;
  readonly extensionsDir: string;
}

export function resolveConfigPaths(input: ConfigPathInput = {}): ConfigPaths {
  const platform = input.platform ?? currentPlatform();
  const home = input.homeDir ?? homedir();
  const env = input.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;

  let configRoot: string;
  let dataRoot: string;
  let cacheRoot: string;

  switch (platform) {
    case "darwin": {
      const applicationSupport = path.join(home, "Library", "Application Support", "Brisk");
      configRoot = applicationSupport;
      dataRoot = applicationSupport;
      cacheRoot = path.join(home, "Library", "Caches", "Brisk");
      break;
    }
    case "win32": {
      const roaming = absoluteEnvironmentPath(
        env.APPDATA,
        path.join(home, "AppData", "Roaming"),
        win32.isAbsolute,
      );
      const local = absoluteEnvironmentPath(
        env.LOCALAPPDATA,
        path.join(home, "AppData", "Local"),
        win32.isAbsolute,
      );
      configRoot = path.join(roaming, "Brisk");
      dataRoot = path.join(roaming, "Brisk");
      cacheRoot = path.join(local, "Brisk", "Cache");
      break;
    }
    case "linux": {
      const configHome = absoluteEnvironmentPath(
        env.XDG_CONFIG_HOME,
        path.join(home, ".config"),
        posix.isAbsolute,
      );
      const dataHome = absoluteEnvironmentPath(
        env.XDG_DATA_HOME,
        path.join(home, ".local", "share"),
        posix.isAbsolute,
      );
      const cacheHome = absoluteEnvironmentPath(
        env.XDG_CACHE_HOME,
        path.join(home, ".cache"),
        posix.isAbsolute,
      );
      configRoot = path.join(configHome, "brisk");
      dataRoot = path.join(dataHome, "brisk");
      cacheRoot = path.join(cacheHome, "brisk");
      break;
    }
  }

  return {
    platform,
    configRoot,
    dataRoot,
    cacheRoot,
    globalConfigPath: path.join(configRoot, "config.jsonc"),
    sessionsDir: path.join(dataRoot, "sessions"),
    artifactsDir: path.join(dataRoot, "artifacts"),
    authPath: path.join(dataRoot, "auth.db"),
    modelCachePath: path.join(cacheRoot, "models.json"),
    sessionIndexPath: path.join(dataRoot, "session-index.json"),
    extensionsDir: path.join(dataRoot, "extensions"),
  };
}

export function projectConfigPath(
  workspace: string,
  platform: ConfigPlatform = currentPlatform(),
): string {
  return (platform === "win32" ? win32 : posix).join(workspace, ".brisk", "config.jsonc");
}

export async function ensurePrivateDirectory(
  directory: string,
  platform: ConfigPlatform = currentPlatform(),
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(directory, 0o700);
}

export async function ensureConfigDirectories(
  paths: ConfigPaths,
  platform: ConfigPlatform = paths.platform,
): Promise<void> {
  await Promise.all(
    [
      paths.configRoot,
      paths.dataRoot,
      paths.cacheRoot,
      paths.sessionsDir,
      paths.artifactsDir,
      paths.extensionsDir,
    ].map((directory) => ensurePrivateDirectory(directory, platform)),
  );
}

function absoluteEnvironmentPath(
  value: string | undefined,
  fallback: string,
  isAbsolute: (path: string) => boolean,
): string {
  return value !== undefined && value !== "" && isAbsolute(value) ? value : fallback;
}

function currentPlatform(): ConfigPlatform {
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  return "linux";
}
