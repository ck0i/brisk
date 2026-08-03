export type PermissionMode = "safe" | "write" | "yolo";

export type CliCommand =
  | {
      readonly name: "tui";
      readonly directory: string;
      readonly continueLast: boolean;
      readonly sessionId?: string;
      readonly model?: string;
      readonly permissionMode?: PermissionMode;
      readonly fakeProvider: boolean;
    }
  | {
      readonly name: "auth";
      readonly action: "login" | "logout" | "status";
      readonly provider?: string;
      readonly json: boolean;
    }
  | { readonly name: "models"; readonly json: boolean; readonly refresh: boolean }
  | { readonly name: "sessions"; readonly json: boolean }
  | { readonly name: "doctor"; readonly json: boolean }
  | { readonly name: "bench"; readonly json: boolean }
  | { readonly name: "version" }
  | { readonly name: "help" };

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly fakeProviderEnv?: boolean } = {},
): CliCommand {
  const cwd = options.cwd ?? process.cwd();
  const first = argv[0];

  if (first === "version" || first === "--version" || first === "-v") {
    ensureNoTrailing(argv, 1, "version");
    return { name: "version" };
  }
  if (first === "help" || first === "--help" || first === "-h") return { name: "help" };
  if (first === "auth") return parseAuth(argv.slice(1));
  if (first === "models") return parseListCommand("models", argv.slice(1));
  if (first === "sessions") return parseListCommand("sessions", argv.slice(1));
  if (first === "doctor") return parseListCommand("doctor", argv.slice(1));
  if (first === "bench") return parseListCommand("bench", argv.slice(1));

  let directory = cwd;
  let directorySeen = false;
  let continueLast = false;
  let sessionId: string | undefined;
  let model: string | undefined;
  let permissionMode: PermissionMode | undefined;
  let fakeProvider = options.fakeProviderEnv ?? false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    switch (value) {
      case "--continue":
      case "-c":
        continueLast = true;
        break;
      case "--session":
        sessionId = requiredValue(argv, ++index, "--session");
        break;
      case "--model":
        model = requiredValue(argv, ++index, "--model");
        if (!model.includes("/")) {
          throw new CliArgumentError("--model must use provider/model format");
        }
        break;
      case "--permission-mode": {
        const candidate = requiredValue(argv, ++index, "--permission-mode");
        if (candidate !== "safe" && candidate !== "write" && candidate !== "yolo") {
          throw new CliArgumentError("--permission-mode must be safe, write, or yolo");
        }
        permissionMode = candidate;
        break;
      }
      case "--fake-provider":
        fakeProvider = true;
        break;
      case "--help":
      case "-h":
        return { name: "help" };
      default:
        if (value.startsWith("-")) throw new CliArgumentError(`Unknown option: ${value}`);
        if (directorySeen) throw new CliArgumentError(`Unexpected argument: ${value}`);
        directory = value;
        directorySeen = true;
    }
  }

  if (continueLast && sessionId) {
    throw new CliArgumentError("--continue and --session cannot be used together");
  }

  return {
    name: "tui",
    directory,
    continueLast,
    fakeProvider,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

function parseAuth(argv: readonly string[]): CliCommand {
  const action = argv[0];
  if (action !== "login" && action !== "logout" && action !== "status") {
    throw new CliArgumentError("auth requires login, logout, or status");
  }

  let provider: string | undefined;
  let json = false;
  for (const value of argv.slice(1)) {
    if (value === "--json") json = true;
    else if (value.startsWith("-")) throw new CliArgumentError(`Unknown auth option: ${value}`);
    else if (provider === undefined) provider = value;
    else throw new CliArgumentError(`Unexpected auth argument: ${value}`);
  }
  if (action === "status" && provider !== undefined) {
    throw new CliArgumentError("auth status does not accept a provider");
  }
  return {
    name: "auth",
    action,
    json,
    ...(provider === undefined ? {} : { provider }),
  };
}

function parseListCommand(
  name: "models" | "sessions" | "doctor" | "bench",
  argv: readonly string[],
): CliCommand {
  let json = false;
  let refresh = false;
  for (const value of argv) {
    if (value === "--json") json = true;
    else if (name === "models" && value === "--refresh") refresh = true;
    else throw new CliArgumentError(`Unknown ${name} option: ${value}`);
  }
  if (name === "models") return { name, json, refresh };
  return { name, json };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new CliArgumentError(`${option} requires a value`);
  return value;
}

function ensureNoTrailing(argv: readonly string[], start: number, command: string): void {
  if (argv.length > start) throw new CliArgumentError(`${command} does not accept arguments`);
}
