import {
  AgentLoop,
  type AgentContextLifecycle,
  type AgentEventListener,
} from "../core/agent-loop.ts";
import type { AdvisorSeverity, JsonValue, Message, ToolCall, Usage } from "../core/messages.ts";
import { redactSecrets } from "../providers/secret-redaction.ts";
import type { Provider } from "../providers/types.ts";
import { ToolRegistry, type ToolDefinition } from "../tools/registry.ts";

export const ADVISOR_READ_ONLY_TOOL_NAMES = [
  "read",
  "search",
  "find",
  "list",
  "web_search",
] as const;

export const ADVISOR_SESSION_PROMPT = `## Session role: advisor

You are a read-only reviewer shadowing another Brisk agent. Inspect its incremental transcript and the workspace, then comment only when you find concrete, material guidance.

- You cannot approve, edit, execute shell commands, delegate, or otherwise act on the primary agent's behalf.
- Use the read-only tools to verify suspicions instead of guessing.
- If the agent is on track, stay silent. Do not restate errors or facts already visible in the transcript.
- Surface at most one concise note per update by calling \`advise\`. Normal assistant text is not delivered to the primary agent.
- Use \`nit\` for optional cleanup that can wait for the next step boundary.
- Use \`concern\` for a likely wrong direction, missed requirement, or material correctness risk.
- Use \`blocker\` only when continuing is clearly unsound or would contradict an explicit requirement.
- An update marked in progress is partial work. Withhold nits and concerns until it settles; only a true blocker may interrupt it.
- Address the primary agent directly and propose a concrete correction. Advice is guidance, not an instruction that overrides the user.`;

export interface AdvisorRuntimeOptions {
  readonly primary: AgentLoop;
  readonly provider: Provider;
  readonly model: string;
  readonly tools?: ToolRegistry;
  readonly contextLifecycle?: AgentContextLifecycle;
  readonly additionalSystemPrompt?: readonly string[];
  readonly onError?: (error: unknown) => void;
  readonly onUsage?: (usage: Usage) => void;
  readonly close?: () => void;
}

interface AdviseInput {
  readonly note: string;
  readonly severity: AdvisorSeverity;
}

/**
 * Runs an isolated, read-only reviewer over incremental primary-agent updates.
 * Advisor text is quarantined; only validated `advise` tool calls can reach the primary loop.
 */
export class AdvisorRuntime {
  private readonly loop: AgentLoop;
  private readonly removePrimaryListener: () => void;
  private readonly closeCallback: (() => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private cursor: number;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private pendingInProgress = false;
  private processing = false;
  private currentInProgress = false;
  private handledThisUpdate = false;
  private emittedThisUpdate = false;
  private disposed = false;
  private failureReported = false;
  private readonly delivered = new Map<string, AdvisorSeverity>();
  private readonly deferred = new Map<string, AdviseInput>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: AdvisorRuntimeOptions) {
    this.cursor = options.primary.messages.length;
    this.closeCallback = options.close;
    this.onError = options.onError;
    const tools = options.tools ?? new ToolRegistry();
    tools.register(this.createAdviseTool(options.primary));
    this.loop = new AgentLoop({
      provider: options.provider,
      model: options.model,
      tools,
      ...(options.contextLifecycle === undefined
        ? {}
        : { contextLifecycle: options.contextLifecycle }),
      ...(options.additionalSystemPrompt === undefined
        ? {}
        : { additionalSystemPrompt: options.additionalSystemPrompt }),
      sessionRolePrompt: ADVISOR_SESSION_PROMPT,
      stopWhen: () => this.handledThisUpdate,
      maxRetries: 1,
      retryDelayMs: 1_000,
    });
    if (options.onUsage) {
      this.loop.subscribe((event) => {
        if (event.type === "usage") options.onUsage?.(event.usage);
      });
    }
    const listener: AgentEventListener = (event) => {
      if (
        event.type === "assistant_message" ||
        event.type === "tool_result" ||
        event.type === "idle"
      ) {
        this.scheduleUpdate(options.primary);
      }
    };
    this.removePrimaryListener = options.primary.subscribe(listener);
  }

  get model(): string {
    return this.loop.modelId;
  }

  get busy(): boolean {
    return this.processing || this.pending || this.updateTimer !== undefined;
  }

  waitForIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removePrimaryListener();
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pending = false;
    this.loop.cancel();
    this.closeCallback?.();
    this.resolveIdleWaiters();
  }

  private scheduleUpdate(primary: AgentLoop): void {
    if (this.disposed || this.updateTimer !== undefined) return;
    // A timer lets a terminal turn clear AgentLoop.active before we classify the
    // update, while ordinary tool loops remain active and are marked in progress.
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.pending = true;
      this.pendingInProgress = primary.active;
      void this.drain(primary);
    }, 0);
  }

  private async drain(primary: AgentLoop): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      while (this.pending && !this.disposed) {
        this.pending = false;
        const inProgress = this.pendingInProgress;
        const snapshot = primary.messages;
        const delta = snapshot.slice(this.cursor);
        this.cursor = snapshot.length;
        const update = renderAdvisorUpdate(delta, inProgress);
        if (!update) continue;

        this.currentInProgress = inProgress;
        this.handledThisUpdate = false;
        this.emittedThisUpdate = false;
        if (!inProgress) this.flushDeferred(primary);
        try {
          await this.loop.submit(update);
          this.failureReported = false;
        } catch (error) {
          if (!this.disposed && !this.failureReported) {
            this.failureReported = true;
            this.onError?.(error);
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.pending && !this.disposed) void this.drain(primary);
      else this.resolveIdleWaiters();
    }
  }

  private createAdviseTool(primary: AgentLoop): ToolDefinition<AdviseInput> {
    return {
      name: "advise",
      description:
        "Deliver one concise reviewer note to the primary agent. Use nit, concern, or blocker according to urgency; stay silent when no note is needed.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", minLength: 1, maxLength: 8_000 },
          severity: { type: "string", enum: ["nit", "concern", "blocker"] },
        },
        required: ["note"],
        additionalProperties: false,
      },
      readOnly: true,
      parallelSafe: false,
      parse: parseAdviseInput,
      execute: (input) => {
        if (this.handledThisUpdate) return { content: "Only one advisory is accepted per update." };
        this.handledThisUpdate = true;

        const key = normalizeAdvice(input.note);
        if (!key || isContentFreeAdvice(key)) return { content: "Empty guidance ignored." };
        const previous = this.delivered.get(key);
        if (previous && severityRank(input.severity) <= severityRank(previous)) {
          return { content: "Duplicate guidance ignored." };
        }
        if (this.currentInProgress && input.severity !== "blocker") {
          const deferred = this.deferred.get(key);
          if (!deferred || severityRank(input.severity) > severityRank(deferred.severity)) {
            this.deferred.set(key, input);
          }
          return { content: "Deferred until the primary step settles." };
        }
        if (this.emittedThisUpdate) {
          return { content: "Deferred guidance was already delivered for this update." };
        }
        this.delivered.set(key, input.severity);
        this.emittedThisUpdate = true;
        primary.deliverAdvice(input.note, input.severity);
        return { content: "Recorded." };
      },
    };
  }

  private flushDeferred(primary: AgentLoop): void {
    if (this.deferred.size === 0) return;
    const candidates = [...this.deferred.entries()];
    this.deferred.clear();
    candidates.sort(
      ([, left], [, right]) => severityRank(right.severity) - severityRank(left.severity),
    );
    const selected = candidates[0];
    if (!selected) return;
    const [key, advice] = selected;
    const previous = this.delivered.get(key);
    if (previous && severityRank(advice.severity) <= severityRank(previous)) return;
    this.delivered.set(key, advice.severity);
    this.emittedThisUpdate = true;
    primary.deliverAdvice(advice.note, advice.severity);
  }

  private resolveIdleWaiters(): void {
    if (this.busy) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function parseAdviseInput(value: JsonValue): AdviseInput {
  if (!isRecord(value) || typeof value.note !== "string") {
    throw new TypeError("note must be a string");
  }
  const note = value.note.trim();
  if (note.length === 0) throw new TypeError("note cannot be empty");
  const severity = value.severity ?? "nit";
  if (severity !== "nit" && severity !== "concern" && severity !== "blocker") {
    throw new TypeError("severity must be nit, concern, or blocker");
  }
  return { note, severity };
}

function renderAdvisorUpdate(
  messages: readonly Message[],
  inProgress: boolean,
): string | undefined {
  const rendered: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (message.internal === "advisor") continue;
      rendered.push(
        `<primary-user${message.internal ? ' kind="control"' : ""}>\n${escapeXml(message.content)}\n</primary-user>`,
      );
      continue;
    }
    if (message.role === "assistant") {
      const parts: string[] = [];
      if (message.thinking) {
        parts.push(`<reasoning>\n${escapeXml(message.thinking)}\n</reasoning>`);
      }
      if (message.content) {
        parts.push(`<response>\n${escapeXml(message.content)}\n</response>`);
      }
      for (const call of message.toolCalls) parts.push(renderToolCall(call));
      rendered.push(`<primary-assistant>\n${parts.join("\n")}\n</primary-assistant>`);
      continue;
    }
    rendered.push(
      `<primary-tool-result name="${escapeXml(message.name)}" error="${message.isError === true}">\n${escapeXml(message.content)}\n</primary-tool-result>`,
    );
  }
  if (rendered.length === 0) return undefined;
  const state = inProgress ? ' in-progress="true"' : "";
  return redactSecrets(`<session-update${state}>\n${rendered.join("\n")}\n</session-update>`);
}

function renderToolCall(call: ToolCall): string {
  return `<primary-tool-call name="${escapeXml(call.name)}">\n${escapeXml(call.arguments)}\n</primary-tool-call>`;
}

function normalizeAdvice(note: string): string {
  return note
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isContentFreeAdvice(note: string): boolean {
  return /^(?:stop|done|complete|continue|lgtm|looks good|no issues?|nothing to add)$/.test(note);
}

function severityRank(severity: AdvisorSeverity): number {
  return severity === "blocker" ? 2 : severity === "concern" ? 1 : 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
