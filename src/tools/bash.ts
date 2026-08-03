import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import { ArtifactStore, type ArtifactMetadata, type ArtifactWriter } from "./artifact-store.ts";
import { resolveWorkspacePath, throwIfAborted } from "./filesystem.ts";
import { StreamingOutputLimiter, type OutputLimitOptions } from "./output-limiter.ts";
import {
  terminateProcessTree,
  toolProcessRegistry,
  type ProcessRegistry,
} from "./process-registry.ts";
import type { ToolDefinition } from "./registry.ts";

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_TIMEOUT_MS = 600_000;

export interface BashInput {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface BashStreamEvent {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface BashOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: BashStreamEvent) => void | Promise<void>;
  readonly outputLimit?: OutputLimitOptions;
  readonly processRegistry?: ProcessRegistry;
}

export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly artifact?: ArtifactMetadata;
}

export async function runBash(
  workspace: string,
  artifacts: ArtifactStore,
  input: BashInput,
  options: BashOptions = {},
): Promise<BashResult> {
  validateBashInput(input);
  throwIfAborted(options.signal);
  const location = await resolveWorkspacePath(workspace, input.cwd ?? ".");
  const writer = await artifacts.createWriter({
    name: "bash-output.txt",
    mediaType: "text/plain; charset=utf-8",
    encoding: "utf-8",
  });
  const limits = options.outputLimit ?? {};
  const combinedLimiter = new StreamingOutputLimiter(limits);
  const stdoutLimiter = new StreamingOutputLimiter(limits);
  const stderrLimiter = new StreamingOutputLimiter(limits);
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const shell = shellCommand(input.command);
  let subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    subprocess = Bun.spawn(shell, {
      cwd: location.path,
      env: { ...process.env, ...input.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    await writer.abort();
    throw error;
  }

  const registry = options.processRegistry ?? toolProcessRegistry;
  const unregister = registry.register(subprocess);
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let sequence = Promise.resolve();
  const record = (stream: BashStreamEvent["stream"], data: string): Promise<void> => {
    sequence = sequence.then(async () => {
      combinedLimiter.write(data);
      if (stream === "stdout") stdoutLimiter.write(data);
      else stderrLimiter.write(data);
      await writer.write(data);
      await options.onOutput?.({ stream, data });
    });
    return sequence;
  };
  const stop = (): Promise<void> => {
    termination ??= terminateProcessTree(subprocess);
    return termination;
  };
  const onAbort = (): void => {
    void stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    void stop();
  }, timeoutMs);

  try {
    const stdoutTask = consumeTextStream(
      subprocess.stdout,
      async (data) => await record("stdout", data),
    );
    const stderrTask = consumeTextStream(
      subprocess.stderr,
      async (data) => await record("stderr", data),
    );
    const exitCode = await subprocess.exited;
    await Promise.all([stdoutTask, stderrTask]);
    await sequence;
    if (termination) await termination;
    throwIfAborted(options.signal);

    const snapshot = combinedLimiter.snapshot();
    const artifact = snapshot.truncated ? await writer.commit() : await discardWriter(writer);
    const combined = combinedLimiter.finish(artifact);
    const stdout = stdoutLimiter.finish(artifact);
    const stderr = stderrLimiter.finish(artifact);
    return {
      stdout: stdout.content,
      stderr: stderr.content,
      output: combined.content,
      exitCode,
      signal: subprocess.signalCode,
      durationMs: performance.now() - startedAt,
      timedOut,
      truncated: combined.truncated,
      ...(artifact === undefined ? {} : { artifact }),
    };
  } catch (error) {
    await stop();
    await writer.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    unregister();
  }
}

export function createBashTool(
  workspace: string,
  artifacts: ArtifactStore,
  options: Omit<BashOptions, "signal"> = {},
): ToolDefinition<BashInput> {
  return {
    name: "bash",
    description: "Run a command in a jailed workspace shell with bounded, streamed output.",
    inputSchema: BASH_SCHEMA,
    parse: parseBashInput,
    timeoutMs: MAX_BASH_TIMEOUT_MS + 5_000,
    async execute(input, context) {
      const result = await runBash(workspace, artifacts, input, {
        ...options,
        signal: context.signal,
      });
      const status = [
        `exit=${result.exitCode ?? "null"}`,
        ...(result.signal === null ? [] : [`signal=${result.signal}`]),
        `duration=${Math.round(result.durationMs)}ms`,
        ...(result.timedOut ? ["timed_out=true"] : []),
      ].join(" ");
      return {
        content: `${result.output}${result.output.length === 0 ? "" : "\n"}[${status}]`,
        ...(result.exitCode === 0 && !result.timedOut ? {} : { isError: true }),
      };
    },
  };
}

function shellCommand(command: string): string[] {
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", command];
  return ["/bin/sh", "-lc", command];
}

async function consumeTextStream(
  stream: ReadableStream<Uint8Array>,
  consume: (data: string) => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const bytes of stream) {
    const data = decoder.decode(bytes, { stream: true });
    if (data.length > 0) await consume(data);
  }
  const remaining = decoder.decode();
  if (remaining.length > 0) await consume(remaining);
}

async function discardWriter(writer: ArtifactWriter): Promise<undefined> {
  await writer.abort();
  return undefined;
}

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    cwd: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_BASH_TIMEOUT_MS },
  },
  required: ["command"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseBashInput(value: JsonValue): BashInput {
  if (!isJsonObject(value)) throw new Error("arguments must be an object");
  if (typeof value.command !== "string") throw new Error("command must be a string");
  const envValue = value.env;
  let env: Readonly<Record<string, string>> | undefined;
  if (envValue !== undefined) {
    if (
      typeof envValue !== "object" ||
      envValue === null ||
      Array.isArray(envValue) ||
      !Object.values(envValue).every((item) => typeof item === "string")
    ) {
      throw new Error("env must contain only string values");
    }
    env = envValue as Readonly<Record<string, string>>;
  }
  return {
    command: value.command,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(env === undefined ? {} : { env }),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBashInput(input: BashInput): void {
  if (input.command.length === 0) throw new Error("Bash command cannot be empty");
  const timeout = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_BASH_TIMEOUT_MS) {
    throw new RangeError(`Bash timeout must be an integer from 1 through ${MAX_BASH_TIMEOUT_MS}`);
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (key.length === 0 || key.includes("=")) throw new Error(`Invalid environment name: ${key}`);
    if (typeof value !== "string") throw new Error(`Environment value for ${key} must be a string`);
  }
}
