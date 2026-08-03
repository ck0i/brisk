import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

export type CriticalRiskCode =
  | "path_mutation_outside_workspace"
  | "protected_recursive_deletion"
  | "destructive_disk_management"
  | "likely_secret_exfiltration";

export type CriticalRiskDisposition = "block" | "prompt";

export interface CriticalRisk {
  readonly code: CriticalRiskCode;
  readonly disposition: CriticalRiskDisposition;
  readonly reason: string;
}

export interface CriticalOperation {
  readonly workspace: string;
  readonly toolName: string;
  readonly command?: string;
  readonly targetPaths?: readonly string[];
  readonly mutatesPaths?: boolean;
  readonly homeDirectory?: string;
  readonly knownSecretValues?: readonly string[];
}

const DISK_TOOLS = new Set([
  "cfdisk",
  "cgdisk",
  "fdisk",
  "gdisk",
  "parted",
  "sfdisk",
  "sgdisk",
  "wipefs",
]);
const REMOTE_TRANSFER_TOOLS = new Set([
  "curl",
  "ftp",
  "nc",
  "ncat",
  "netcat",
  "rsync",
  "scp",
  "sftp",
  "wget",
]);
const MUTATING_TOOLS = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "shred",
  "tee",
  "touch",
  "truncate",
  "unlink",
]);

/** Classifies only the small set of operations that remain critical in yolo mode. */
export function classifyCriticalOperation(operation: CriticalOperation): readonly CriticalRisk[] {
  const workspace = resolve(operation.workspace);
  const home = resolve(operation.homeDirectory ?? homedir());
  const command = operation.command ?? "";
  const segments = tokenizeShell(command);
  const executableSegments = segments
    .map((tokens) => unwrapExecutable(tokens))
    .filter((tokens): tokens is readonly string[] => tokens !== undefined);
  const risks: CriticalRisk[] = [];

  const commandMutationPaths = executableSegments.flatMap((tokens) => mutationPaths(tokens));
  const mutatesDeclaredPaths =
    operation.mutatesPaths ?? ["edit", "write"].includes(operation.toolName.toLowerCase());
  const declaredMutationPaths = mutatesDeclaredPaths ? [...(operation.targetPaths ?? [])] : [];
  const mutationTargets = unique([...declaredMutationPaths, ...commandMutationPaths]);

  if (mutationTargets.some((path) => !isWithin(workspace, resolvePath(path, workspace, home)))) {
    risks.push({
      code: "path_mutation_outside_workspace",
      disposition: "prompt",
      reason: "May modify a path outside the workspace.",
    });
  }

  if (
    executableSegments.some(
      (tokens) =>
        executableName(tokens) === "rm" &&
        isRecursiveRm(tokens) &&
        rmTargets(tokens).some((path) => isProtectedDeletion(path, workspace, home)),
    )
  ) {
    risks.push({
      code: "protected_recursive_deletion",
      disposition: "block",
      reason: "Recursively deleting the workspace, filesystem root, or home directory is blocked.",
    });
  }

  if (executableSegments.some((tokens) => isDiskManagement(tokens) || hasRawDiskWrite(tokens))) {
    risks.push({
      code: "destructive_disk_management",
      disposition: "block",
      reason: "Destructive disk or partition management is blocked.",
    });
  }

  const hasRemoteTransfer = executableSegments.some((tokens) =>
    REMOTE_TRANSFER_TOOLS.has(executableName(tokens)),
  );
  const containsKnownSecret = (operation.knownSecretValues ?? []).some(
    (secret) => secret.length > 0 && command.includes(secret),
  );
  const referencesCredentialFile = [...segments.flat(), ...(operation.targetPaths ?? [])].some(
    (token) => isKnownCredentialPath(token, workspace, home),
  );
  if (hasRemoteTransfer && (containsKnownSecret || referencesCredentialFile)) {
    risks.push({
      code: "likely_secret_exfiltration",
      disposition: "prompt",
      reason: "A remote transfer appears to include a detected secret or credential file.",
    });
  }

  return risks;
}

/** Replaces known secret values without retaining or exposing them in the result. */
export function redactKnownSecrets(value: string, knownSecretValues: readonly string[]): string {
  let redacted = value;
  const secrets = unique(knownSecretValues.filter((secret) => secret.length > 0)).sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

function tokenizeShell(command: string): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushToken = (): void => {
    if (token.length === 0) return;
    segment.push(token);
    token = "";
  };
  const pushSegment = (): void => {
    pushToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) continue;
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      if (character === "\n") pushSegment();
      continue;
    }
    if (character === ";" || character === "|") {
      pushSegment();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      pushSegment();
      index += 1;
      continue;
    }
    if (character === ">") {
      pushToken();
      segment.push(">");
      if (command[index + 1] === ">") index += 1;
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  pushSegment();
  return segments;
}

function unwrapExecutable(tokens: readonly string[]): readonly string[] | undefined {
  let index = 0;
  while (isAssignment(tokens[index])) index += 1;

  while (index < tokens.length) {
    const name = executableBase(tokens[index]);
    if (name === "command" || name === "nohup") {
      index += 1;
      while (tokens[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (name === "env") {
      index += 1;
      while (tokens[index]?.startsWith("-") || isAssignment(tokens[index])) index += 1;
      continue;
    }
    if (name === "sudo") {
      index += 1;
      index = skipSudoOptions(tokens, index);
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index) : undefined;
}

function skipSudoOptions(tokens: readonly string[], start: number): number {
  let index = start;
  const optionsWithValue = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u"]);
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index];
    index += 1;
    if (option && optionsWithValue.has(option)) index += 1;
  }
  return index;
}

function mutationPaths(tokens: readonly string[]): string[] {
  const name = executableName(tokens);
  if (!MUTATING_TOOLS.has(name)) return redirectTargets(tokens);
  const operands = tokens.slice(1).filter((token) => !token.startsWith("-"));
  const paths: string[] = [];

  switch (name) {
    case "cp":
    case "install":
    case "ln":
    case "mv": {
      const destination = operands.at(-1);
      if (destination) paths.push(destination);
      break;
    }
    case "chmod":
    case "chown": {
      paths.push(...operands.slice(1));
      break;
    }
    case "dd": {
      const output = tokens.find((token) => token.startsWith("of="));
      if (output) paths.push(output.slice(3));
      break;
    }
    default:
      paths.push(...operands);
  }
  paths.push(...redirectTargets(tokens));
  return paths;
}

function redirectTargets(tokens: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === ">") {
      const target = tokens[index + 1];
      if (target) paths.push(target);
    }
  }
  return paths;
}

function rmTargets(tokens: readonly string[]): string[] {
  return tokens.slice(1).filter((token) => token !== "--" && !token.startsWith("-"));
}

function isRecursiveRm(tokens: readonly string[]): boolean {
  return tokens
    .slice(1)
    .some((token) => token === "--recursive" || (/^-[^-]*r/i.test(token) && token !== "-"));
}

function isProtectedDeletion(path: string, workspace: string, home: string): boolean {
  const withoutContentsGlob = path.replace(/\/(?:\*|\.\*)$/, "");
  const resolved = resolvePath(withoutContentsGlob, workspace, home);
  return resolved === workspace || resolved === home || resolved === resolve("/");
}

function isDiskManagement(tokens: readonly string[]): boolean {
  const name = executableName(tokens);
  return /^mkfs(?:\..+)?$/.test(name) || DISK_TOOLS.has(name);
}

function hasRawDiskWrite(tokens: readonly string[]): boolean {
  return mutationPaths(tokens).some(isRawDiskPath);
}

function isRawDiskPath(path: string): boolean {
  return /^\/dev\/(?:[hsv]d[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+|disk\d+)(?:p?\d+)?$/.test(path);
}

function isKnownCredentialPath(path: string, workspace: string, home: string): boolean {
  const normalized = resolvePath(path.replace(/[,:]$/, ""), workspace, home);
  const exact = new Set([
    resolve(home, ".aws/credentials"),
    resolve(home, ".config/gcloud/application_default_credentials.json"),
    resolve(home, ".docker/config.json"),
    resolve(home, ".kube/config"),
    resolve(home, ".netrc"),
    resolve(home, ".npmrc"),
    resolve(home, ".ssh/id_dsa"),
    resolve(home, ".ssh/id_ecdsa"),
    resolve(home, ".ssh/id_ed25519"),
    resolve(home, ".ssh/id_rsa"),
  ]);
  return exact.has(normalized);
}

function resolvePath(path: string, workspace: string, home: string): string {
  const expanded = path
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home);
  return resolve(isAbsolute(expanded) ? expanded : resolve(workspace, expanded));
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" || (path !== ".." && !path.startsWith(`..${separator()}`) && !isAbsolute(path))
  );
}

function separator(): "/" | "\\" {
  return process.platform === "win32" ? "\\" : "/";
}

function executableName(tokens: readonly string[]): string {
  return executableBase(tokens[0]) ?? "";
}

function executableBase(token: string | undefined): string | undefined {
  return token === undefined ? undefined : basename(token).toLowerCase();
}

function isAssignment(token: string | undefined): boolean {
  return token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
