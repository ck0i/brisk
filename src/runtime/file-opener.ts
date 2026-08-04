import { basename } from "node:path";

export interface FileEditorOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function fileEditorCommand(
  path: string,
  options: FileEditorOptions = {},
): { readonly command: readonly string[]; readonly environment: Readonly<Record<string, string>> } {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const configured = environment.BRISK_EDITOR ?? environment.VISUAL ?? environment.EDITOR;
  const childEnvironment = {
    ...definedEnvironment(environment),
    BRISK_OPEN_PATH: path,
  };

  if (configured?.trim()) {
    return {
      command:
        platform === "win32"
          ? ["cmd.exe", "/d", "/s", "/c", `${configured} "%BRISK_OPEN_PATH%"`]
          : ["/bin/sh", "-lc", `exec ${configured} "$BRISK_OPEN_PATH"`],
      environment: childEnvironment,
    };
  }
  if (platform === "darwin") {
    return { command: ["open", path], environment: childEnvironment };
  }
  if (platform === "win32") {
    return {
      command: ["cmd.exe", "/d", "/s", "/c", "start", "", path],
      environment: childEnvironment,
    };
  }
  return { command: ["xdg-open", path], environment: childEnvironment };
}

export async function openFileInEditor(
  path: string,
  options: FileEditorOptions = {},
): Promise<void> {
  const invocation = fileEditorCommand(path, options);
  let process_: Bun.Subprocess<"inherit", "inherit", "inherit">;
  try {
    process_ = Bun.spawn([...invocation.command], {
      env: invocation.environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    throw new Error(`Unable to start an editor for ${basename(path)}`, { cause: error });
  }
  const exitCode = await process_.exited;
  if (exitCode !== 0) throw new Error(`Editor exited with code ${exitCode}`);
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
