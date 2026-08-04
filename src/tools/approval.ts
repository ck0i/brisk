import { resolve } from "node:path";

import {
  classifyCriticalOperation,
  redactKnownSecrets,
  type CriticalRisk,
} from "./security-classifier.ts";

export type PermissionMode = "safe" | "write" | "yolo";
export type ApprovalDecision = "approve_once" | "approve_session" | "deny";
export type TaskPermission = "research" | "patch";

export interface ApprovalRequest {
  readonly toolName: string;
  readonly summary: string;
  readonly command?: string;
  readonly diff?: string;
  readonly targetPaths: readonly string[];
  readonly riskDescription: string;
  readonly equivalenceKey: string;
}

export interface ApprovalHandler {
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export interface ToolPermissionRequest {
  readonly toolName: string;
  readonly summary: string;
  readonly command?: string;
  readonly diff?: string;
  readonly targetPaths?: readonly string[];
  readonly mutatesPaths?: boolean;
  readonly taskPermission?: TaskPermission;
}

export interface PermissionManagerOptions {
  readonly mode: PermissionMode;
  readonly workspace: string;
  readonly handler: ApprovalHandler;
  readonly knownSecretValues?: readonly string[];
  readonly homeDirectory?: string;
  readonly taskPatchPermission?: "prompt" | "allow";
}

export interface PermissionEvaluation {
  readonly action: "allow" | "prompt" | "block";
  readonly risks: readonly CriticalRisk[];
  readonly riskDescription: string;
}

const ALWAYS_ALLOWED_TOOLS = new Set(["find", "list", "read", "search"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

export class PermissionManager {
  private readonly mode: PermissionMode;
  private readonly workspace: string;
  private readonly handler: ApprovalHandler;
  private readonly knownSecretValues: readonly string[];
  private readonly homeDirectory: string | undefined;
  private readonly taskPatchPermission: "prompt" | "allow";
  private readonly sessionApprovals = new Set<string>();

  constructor(options: PermissionManagerOptions) {
    this.mode = options.mode;
    this.workspace = resolve(options.workspace);
    this.handler = options.handler;
    this.knownSecretValues = [...(options.knownSecretValues ?? [])];
    this.homeDirectory = options.homeDirectory;
    this.taskPatchPermission = options.taskPatchPermission ?? "prompt";
  }

  evaluate(request: ToolPermissionRequest): PermissionEvaluation {
    const toolName = request.toolName.toLowerCase();
    if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
      return { action: "allow", risks: [], riskDescription: "Read-only operation." };
    }

    const risks = classifyCriticalOperation({
      workspace: this.workspace,
      toolName,
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.targetPaths === undefined ? {} : { targetPaths: request.targetPaths }),
      ...(request.mutatesPaths === undefined ? {} : { mutatesPaths: request.mutatesPaths }),
      ...(this.homeDirectory === undefined ? {} : { homeDirectory: this.homeDirectory }),
      knownSecretValues: this.knownSecretValues,
    });
    if (risks.some((risk) => risk.disposition === "block")) {
      return {
        action: "block",
        risks,
        riskDescription: risks.map((risk) => risk.reason).join(" "),
      };
    }
    if (this.mode === "yolo") {
      return {
        action: "allow",
        risks,
        riskDescription: "Allowed without prompting in yolo mode.",
      };
    }

    const policyRisk = policyPromptReason(
      toolName,
      this.mode,
      request.taskPermission,
      this.taskPatchPermission,
    );
    const criticalPrompt = risks.some((risk) => risk.disposition === "prompt");
    if (!policyRisk && !criticalPrompt) {
      return { action: "allow", risks, riskDescription: "Allowed by the active permission mode." };
    }

    return {
      action: "prompt",
      risks,
      riskDescription: [policyRisk, ...risks.map((risk) => risk.reason)]
        .filter((reason): reason is string => reason !== undefined)
        .join(" "),
    };
  }

  async authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<boolean> {
    const evaluation = this.evaluate(request);
    if (evaluation.action === "allow") return true;
    if (evaluation.action === "block" || signal?.aborted) return false;

    const approvalRequest = this.createApprovalRequest(request, evaluation.riskDescription);
    if (this.sessionApprovals.has(approvalRequest.equivalenceKey)) return true;

    const decision = await this.handler.requestApproval(approvalRequest, signal);
    if (signal?.aborted) return false;
    if (decision === "approve_session") {
      this.sessionApprovals.add(approvalRequest.equivalenceKey);
      return true;
    }
    return decision === "approve_once";
  }

  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
  }

  private createApprovalRequest(
    request: ToolPermissionRequest,
    riskDescription: string,
  ): ApprovalRequest {
    const redact = (value: string): string => redactKnownSecrets(value, this.knownSecretValues);
    const toolName = redact(request.toolName.toLowerCase());
    const summary = concise(redact(request.summary));
    const command = request.command === undefined ? undefined : redact(request.command);
    const diff = request.diff === undefined ? undefined : redact(request.diff);
    const targetPaths = (request.targetPaths ?? []).map(redact);
    const risk = redact(riskDescription);
    const canonicalEquivalence = JSON.stringify({
      toolName: request.toolName.toLowerCase(),
      taskPermission: request.taskPermission ?? null,
      command: request.command ?? null,
      targetPaths: request.targetPaths ?? [],
      mutatesPaths: request.mutatesPaths ?? null,
      risks: this.evaluate(request).risks.map((finding) => finding.code),
    });
    const equivalenceKey = `permission-v1:${toolName}:${stableHash(canonicalEquivalence)}`;

    return {
      toolName,
      summary,
      ...(command === undefined ? {} : { command }),
      ...(diff === undefined ? {} : { diff }),
      targetPaths,
      riskDescription: risk,
      equivalenceKey,
    };
  }
}

function policyPromptReason(
  toolName: string,
  mode: PermissionMode,
  taskPermission: TaskPermission | undefined,
  taskPatchPermission: "prompt" | "allow",
): string | undefined {
  if (toolName === "task") {
    if (taskPermission === "research") return undefined;
    if (taskPermission === "patch" && taskPatchPermission === "allow") return undefined;
    return "A delegated patch task may modify workspace files.";
  }
  if (WRITE_TOOLS.has(toolName)) {
    return mode === "safe" ? "May modify workspace files." : undefined;
  }
  if (toolName === "bash") {
    return mode === "yolo" ? undefined : "Runs a shell command.";
  }
  return mode === "yolo" ? undefined : "This tool requires approval in the active mode.";
}

function concise(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
