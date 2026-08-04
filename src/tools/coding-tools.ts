import type { JsonValue } from "../core/messages.ts";
import type { JsonSchema } from "../providers/types.ts";
import { PermissionManager, type ApprovalHandler, type PermissionMode } from "./approval.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { createBashTool, type BashInput } from "./bash.ts";
import { createFindTool } from "./find.ts";
import {
  HashlineWorkspace,
  type HashlineEditInput,
  type HashlineReadInput,
  type HashlineWriteInput,
  type PendingHashlineChange,
} from "./hashline-workspace.ts";
import { createListTool } from "./list.ts";
import { OutputLimiter } from "./output-limiter.ts";
import {
  ToolRegistry,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./registry.ts";
import { createSearchTool } from "./search.ts";

export type CodingToolName = "read" | "edit" | "write" | "search" | "find" | "list" | "bash";

export interface CodingToolsOptions {
  readonly workspace: string;
  readonly artifactsDirectory: string;
  readonly permissionMode: PermissionMode;
  readonly approvalHandler: ApprovalHandler;
  readonly knownSecretValues?: readonly string[];
  readonly enabledTools?: readonly CodingToolName[];
}

export interface CodingToolServices {
  readonly artifacts: ArtifactStore;
  readonly hashline: HashlineWorkspace;
  readonly permissions: PermissionManager;
}

/** Register the native coding tools into an existing session registry. */
export async function registerCodingTools(
  registry: ToolRegistry,
  options: CodingToolsOptions,
): Promise<CodingToolServices> {
  const artifacts = new ArtifactStore(options.artifactsDirectory);
  await artifacts.initialize();
  const hashline = new HashlineWorkspace({
    workspace: options.workspace,
    artifactReader: artifacts,
    maxReadOutputBytes: 2 * 1024 * 1024,
  });
  const permissions = new PermissionManager({
    mode: options.permissionMode,
    workspace: options.workspace,
    handler: options.approvalHandler,
    knownSecretValues: options.knownSecretValues ?? collectKnownSecretValues(),
  });

  const limiter = (name: string): OutputLimiter =>
    new OutputLimiter(artifacts, {
      headChars: 24_000,
      tailChars: 8_000,
      artifactName: `${name}-output.txt`,
      mediaType: "text/plain; charset=utf-8",
    });

  const enabled = new Set<CodingToolName>(
    options.enabledTools ?? ["read", "edit", "write", "search", "find", "list", "bash"],
  );
  if (enabled.has("read")) registry.register(createReadTool(hashline, limiter("read")));
  if (enabled.has("edit")) {
    registry.register(createEditTool(hashline, permissions, limiter("edit")));
  }
  if (enabled.has("write")) {
    registry.register(createWriteTool(hashline, permissions, limiter("write")));
  }
  if (enabled.has("search")) {
    registry.register(withOutputLimit(createSearchTool(options.workspace), limiter("search")));
  }
  if (enabled.has("find")) {
    registry.register(withOutputLimit(createFindTool(options.workspace), limiter("find")));
  }
  if (enabled.has("list")) {
    registry.register(withOutputLimit(createListTool(options.workspace), limiter("list")));
  }
  if (enabled.has("bash")) {
    registry.register(createAuthorizedBashTool(options.workspace, artifacts, permissions));
  }

  return { artifacts, hashline, permissions };
}

function createReadTool(
  hashline: HashlineWorkspace,
  limiter: OutputLimiter,
): ToolDefinition<HashlineReadInput> {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file with a Hashline snapshot header and numbered edit anchors. Use line ranges for large files; range ends past EOF are clamped.",
    inputSchema: READ_SCHEMA,
    readOnly: true,
    parallelSafe: true,
    parse: parseReadInput,
    async execute(input) {
      const result = await hashline.read(input);
      return { content: (await limiter.limit(result.content)).content };
    },
  };
}

function createEditTool(
  hashline: HashlineWorkspace,
  permissions: PermissionManager,
  limiter: OutputLimiter,
): ToolDefinition<HashlineEditInput> {
  return {
    name: "edit",
    description:
      "Apply a native Hashline patch. Every section must begin with the exact [path#TAG] header returned by read.",
    inputSchema: EDIT_SCHEMA,
    parse: parseEditInput,
    async execute(input, context) {
      const pending = await hashline.edit(input);
      return await approveAndCommit(pending, permissions, context, limiter);
    },
  };
}

function createWriteTool(
  hashline: HashlineWorkspace,
  permissions: PermissionManager,
  limiter: OutputLimiter,
): ToolDefinition<HashlineWriteInput> {
  return {
    name: "write",
    description:
      "Create a new UTF-8 text file or explicitly replace an entire existing file. Prefer edit for localized changes.",
    inputSchema: WRITE_SCHEMA,
    parse: parseWriteInput,
    async execute(input, context) {
      const pending = await hashline.write(input);
      return await approveAndCommit(pending, permissions, context, limiter);
    },
  };
}

function createAuthorizedBashTool(
  workspace: string,
  artifacts: ArtifactStore,
  permissions: PermissionManager,
): ToolDefinition<BashInput> {
  const definition = createBashTool(workspace, artifacts);
  return {
    ...definition,
    async execute(input, context) {
      const evaluation = permissions.evaluate({
        toolName: "bash",
        summary: input.command,
        command: input.command,
        targetPaths: input.cwd ? [input.cwd] : ["."],
      });
      if (evaluation.action === "block") {
        return { content: `Blocked bash command: ${evaluation.riskDescription}`, isError: true };
      }
      const allowed = await permissions.authorize(
        {
          toolName: "bash",
          summary: input.command,
          command: input.command,
          targetPaths: input.cwd ? [input.cwd] : ["."],
        },
        context.signal,
      );
      if (!allowed) return { content: "Bash command denied by user or policy.", isError: true };
      return await definition.execute(input, context);
    },
  };
}

async function approveAndCommit(
  pending: PendingHashlineChange,
  permissions: PermissionManager,
  context: ToolContext,
  limiter: OutputLimiter,
): Promise<ToolResult> {
  const targets = pending.preview.files.map((file) => file.path);
  context.emitPreview({
    summary: targets.join(", "),
    diff: pending.preview.diff,
    targetPaths: targets,
  });
  const evaluation = permissions.evaluate({
    toolName: pending.preview.kind,
    summary: `${pending.preview.kind} ${targets.join(", ")}`,
    diff: pending.preview.diff,
    targetPaths: targets,
    mutatesPaths: true,
  });
  if (evaluation.action === "block") {
    pending.discard();
    return {
      content: `Blocked ${pending.preview.kind}: ${evaluation.riskDescription}`,
      isError: true,
    };
  }
  const allowed = await permissions.authorize(
    {
      toolName: pending.preview.kind,
      summary: `${pending.preview.kind} ${targets.join(", ")}`,
      diff: pending.preview.diff,
      targetPaths: targets,
      mutatesPaths: true,
    },
    context.signal,
  );
  if (!allowed) {
    pending.discard();
    return {
      content: `${capitalize(pending.preview.kind)} denied by user or policy.`,
      isError: true,
    };
  }

  const result = await pending.commit();
  const warnings = result.files.flatMap((file) =>
    file.warnings.map((warning) => `${file.path}: ${warning}`),
  );
  const summary = [
    `${capitalize(result.kind)} committed atomically:`,
    ...result.files.map((file) => `- ${file.op} ${file.path} ${file.header}`),
    ...(warnings.length === 0 ? [] : ["Warnings:", ...warnings.map((warning) => `- ${warning}`)]),
    "",
    result.diff,
  ].join("\n");
  return { content: (await limiter.limit(summary)).content };
}

function withOutputLimit<TArguments>(
  definition: ToolDefinition<TArguments>,
  limiter: OutputLimiter,
): ToolDefinition<TArguments> {
  return {
    ...definition,
    async execute(input, context) {
      const result = await definition.execute(input, context);
      return { ...result, content: (await limiter.limit(result.content)).content };
    },
  };
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    ranges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "integer", minimum: 1 },
          end: {
            type: "integer",
            minimum: 1,
            description: "Inclusive end line; values past EOF are clamped.",
          },
        },
        required: ["start"],
        additionalProperties: false,
      },
    },
    maxOutputBytes: { type: "integer", minimum: 1, maximum: 2 * 1024 * 1024 },
  },
  required: ["path"],
  additionalProperties: false,
} satisfies JsonSchema;

const EDIT_SCHEMA = {
  type: "object",
  properties: { patch: { type: "string", minLength: 1 } },
  required: ["patch"],
  additionalProperties: false,
} satisfies JsonSchema;

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string" },
    mode: { type: "string", enum: ["create", "replace"] },
  },
  required: ["path", "content", "mode"],
  additionalProperties: false,
} satisfies JsonSchema;

function parseReadInput(value: JsonValue): HashlineReadInput {
  const object = requireObject(value);
  if (typeof object.path !== "string") throw new Error("path must be a string");
  let ranges: HashlineReadInput["ranges"];
  if (object.ranges !== undefined) {
    if (!Array.isArray(object.ranges)) throw new Error("ranges must be an array");
    ranges = object.ranges.map((range) => {
      const item = requireObject(range);
      if (typeof item.start !== "number") throw new Error("range start must be a number");
      return {
        start: item.start,
        ...(typeof item.end === "number" ? { end: item.end } : {}),
      };
    });
  }
  return {
    path: object.path,
    ...(ranges === undefined ? {} : { ranges }),
    ...(typeof object.maxOutputBytes === "number" ? { maxOutputBytes: object.maxOutputBytes } : {}),
  };
}

function parseEditInput(value: JsonValue): HashlineEditInput {
  const object = requireObject(value);
  if (typeof object.patch !== "string") throw new Error("patch must be a string");
  return { patch: object.patch };
}

function parseWriteInput(value: JsonValue): HashlineWriteInput {
  const object = requireObject(value);
  if (typeof object.path !== "string") throw new Error("path must be a string");
  if (typeof object.content !== "string") throw new Error("content must be a string");
  if (object.mode !== "create" && object.mode !== "replace") {
    throw new Error('mode must be "create" or "replace"');
  }
  return { path: object.path, content: object.content, mode: object.mode };
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function collectKnownSecretValues(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(environment)
    .filter(([key, value]) =>
      Boolean(value && value.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)),
    )
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
