import type { AgentLoop } from "../core/agent-loop.ts";
import type { JsonValue, Message } from "../core/messages.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import type { SessionRuntime } from "./session-runtime.ts";

const GOAL_STATE_KEY = "goal";
const GOAL_CONTROL = "goal-control" as const;

type GoalStatus = "active" | "paused";
type PersistedGoalStatus = GoalStatus | "completed" | "dropped";
type PauseReason = "user" | "limit" | "aborted" | "error";

interface GoalState {
  objective: string;
  status: GoalStatus;
  continuationTurns: number;
  maxContinuationTurns?: number;
  pauseReason?: PauseReason;
}

interface PersistedGoalState {
  version: 1;
  objective: string;
  status: PersistedGoalStatus;
  continuationTurns: number;
  maxContinuationTurns?: number;
  pauseReason?: PauseReason;
  reason?: string;
}

interface GoalToolInput {
  readonly op: "get" | "complete" | "drop";
}

export interface GoalRuntimeOptions {
  readonly session: SessionRuntime;
  readonly configuredMaxTurns: () => number | undefined;
  readonly notify: (message: string) => void;
  readonly setStatus: (status: string | undefined) => void;
}

/** Persistent, autonomous goal mode and its model-facing completion tool. */
export class GoalRuntime {
  readonly tool: ToolDefinition<GoalToolInput>;
  private goal: GoalState | undefined;
  private unsubscribe: (() => void) | undefined;
  private submitControl: ((text: string) => Promise<void>) | undefined;
  private failedReason: "aborted" | "error" | undefined;
  private settling = false;
  private settleAgain = false;
  private stopRequested = false;

  constructor(private readonly options: GoalRuntimeOptions) {
    this.tool = this.createTool();
  }

  get objective(): string | undefined {
    return this.goal?.objective;
  }

  get status(): GoalStatus | undefined {
    return this.goal?.status;
  }

  restore(): void {
    let latest: PersistedGoalState | undefined;
    for (const entry of this.options.session.current.entries) {
      if (entry.type !== "mode_state" || entry.key !== GOAL_STATE_KEY) continue;
      latest = parseStoredGoal(entry.value) ?? latest;
    }
    this.goal =
      latest?.status === "active" || latest?.status === "paused"
        ? {
            objective: latest.objective,
            status: latest.status,
            continuationTurns: latest.continuationTurns,
            ...(latest.maxContinuationTurns === undefined
              ? {}
              : { maxContinuationTurns: latest.maxContinuationTurns }),
            ...(latest.pauseReason === undefined ? {} : { pauseReason: latest.pauseReason }),
          }
        : undefined;
    this.failedReason = undefined;
    this.stopRequested = false;
    this.updateStatus();
  }

  attach(loop: AgentLoop, submitControl: (text: string) => Promise<void>): void {
    this.detachAgent();
    this.submitControl = submitControl;
    this.unsubscribe = loop.subscribe((event) => {
      if (!this.goal || this.goal.status !== "active") return;
      if (event.type === "cancelled") this.failedReason = "aborted";
      else if (event.type === "error") this.failedReason = "error";
      else if (event.type === "idle") this.scheduleSettled();
    });
  }

  detachAgent(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.submitControl = undefined;
    this.failedReason = undefined;
    this.settling = false;
    this.settleAgain = false;
  }

  clearStatus(): void {
    this.options.setStatus(undefined);
  }

  /** Keep only the newest hidden control while active; remove all stale controls otherwise. */
  filterContext(messages: readonly Message[]): readonly Message[] {
    let keep = -1;
    if (this.goal?.status === "active") {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "user" && message.internal === GOAL_CONTROL) {
          keep = index;
          break;
        }
      }
    }
    return messages.filter(
      (message, index) =>
        message.role !== "user" || message.internal !== GOAL_CONTROL || index === keep,
    );
  }

  dynamicSystemPrompt(): readonly string[] {
    return this.goal?.status === "active" ? [buildReminder(this.goal.objective)] : [];
  }

  consumeStopRequested(): boolean {
    const requested = this.stopRequested;
    this.stopRequested = false;
    return requested;
  }

  async execute(argumentValue: string): Promise<void> {
    const input = argumentValue.trim();
    if (!input) {
      this.options.notify(
        "Usage: /goal <objective> | /goal set <objective> | /goal show | pause | resume | drop",
      );
      return;
    }

    const firstSpace = input.search(/\s/);
    const command = (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase();
    const remainder = firstSpace === -1 ? "" : input.slice(firstSpace).trim();

    switch (command) {
      case "show":
        if (!remainder) {
          this.showGoal();
          return;
        }
        break;
      case "pause":
        if (!remainder) {
          if (!this.goal) this.options.notify("No goal is set.");
          else if (this.goal.status === "paused") this.options.notify("Goal is already paused.");
          else {
            await this.pauseGoal("user");
            this.options.notify(
              "Goal paused. Use /goal resume to continue or /goal drop to abandon it.",
            );
          }
          return;
        }
        break;
      case "resume":
        if (!remainder) {
          if (!this.goal) {
            this.options.notify("No paused goal is available.");
            return;
          }
          if (this.goal.status === "paused") {
            if (this.goal.pauseReason === "limit") this.goal.continuationTurns = 0;
            this.goal.status = "active";
            delete this.goal.pauseReason;
            await this.persist(this.goal);
            this.updateStatus();
            this.options.notify("Goal resumed.");
          } else {
            this.options.notify("Goal is already active; continuing now.");
          }
          this.triggerGoalTurn("kickoff");
          return;
        }
        break;
      case "drop":
        if (!remainder) {
          if (await this.finishGoal("dropped", "user")) this.options.notify("Goal dropped.");
          else this.options.notify("No goal is set.");
          return;
        }
        break;
      case "set":
        if (!remainder) {
          this.options.notify("Usage: /goal set <objective>");
          return;
        }
        await this.startGoal(remainder);
        return;
    }

    await this.startGoal(input);
  }

  private async startGoal(objective: string): Promise<void> {
    if (this.goal) {
      this.options.notify(
        `A goal is already ${this.goal.status}. Use /goal drop before creating another goal.`,
      );
      return;
    }
    if (!this.submitControl) {
      this.options.notify("Select a model before starting a goal.");
      return;
    }

    const configuredLimit = this.options.configuredMaxTurns();
    this.goal = {
      objective,
      status: "active",
      continuationTurns: 0,
      ...(configuredLimit === undefined ? {} : { maxContinuationTurns: configuredLimit }),
    };
    await this.persist(this.goal);
    this.updateStatus();
    this.options.notify(
      configuredLimit === undefined
        ? "Goal mode active with no continuation limit."
        : `Goal mode active (maximum ${configuredLimit} continuation turns).`,
    );
    this.triggerGoalTurn("kickoff");
  }

  private showGoal(): void {
    const current = this.goal;
    if (!current) {
      this.options.notify(
        `No goal is set. Continuation limit: ${formatLimit(this.options.configuredMaxTurns())}.`,
      );
      return;
    }
    const reason = current.pauseReason ? ` (${current.pauseReason})` : "";
    this.options.notify(
      `Goal: ${current.status}${reason}\nContinuations: ${current.continuationTurns}/${formatLimit(current.maxContinuationTurns)}\n\n${current.objective}`,
    );
  }

  private triggerGoalTurn(kind: "kickoff" | "continuation"): void {
    const submit = this.submitControl;
    if (!submit || !this.goal || this.goal.status !== "active") return;
    void submit(buildControlMessage(kind)).catch(() => {
      // Provider failures and cancellations are handled by the attached event listener.
    });
  }

  private scheduleSettled(): void {
    if (this.settling) {
      this.settleAgain = true;
      return;
    }
    this.settling = true;
    void this.handleSettled()
      .catch((error: unknown) => {
        if (this.goal?.status === "active") {
          this.goal.status = "paused";
          this.goal.pauseReason = "error";
          this.updateStatus();
        }
        this.options.notify(`Goal continuation failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.settling = false;
        if (this.settleAgain) {
          this.settleAgain = false;
          this.scheduleSettled();
        }
      });
  }

  private async handleSettled(): Promise<void> {
    const current = this.goal;
    if (!current || current.status !== "active") return;

    const failedReason = this.failedReason;
    this.failedReason = undefined;
    if (failedReason) {
      await this.pauseGoal(failedReason);
      this.options.notify(
        `Goal paused because the agent turn ${failedReason}. Use /goal resume to retry.`,
      );
      return;
    }

    if (
      current.maxContinuationTurns !== undefined &&
      current.continuationTurns >= current.maxContinuationTurns
    ) {
      const reachedLimit = current.maxContinuationTurns;
      await this.pauseGoal("limit");
      this.options.notify(
        `Goal paused after reaching the ${reachedLimit}-turn continuation limit. Use /goal resume to authorize another run.`,
      );
      return;
    }

    current.continuationTurns += 1;
    await this.persist(current);
    if (this.goal !== current || current.status !== "active") return;
    this.updateStatus();
    this.triggerGoalTurn("continuation");
  }

  private async pauseGoal(reason: PauseReason): Promise<void> {
    const current = this.goal;
    if (!current) return;
    current.status = "paused";
    current.pauseReason = reason;
    this.updateStatus();
    await this.persist(current);
  }

  private async finishGoal(
    status: "completed" | "dropped",
    reason: string,
  ): Promise<GoalState | undefined> {
    const previous = this.goal;
    if (!previous) return undefined;
    this.goal = undefined;
    await this.persist(previous, status, reason);
    this.updateStatus();
    return previous;
  }

  private async persist(
    state: GoalState,
    status: PersistedGoalStatus = state.status,
    reason?: string,
  ): Promise<void> {
    const stored: PersistedGoalState = {
      version: 1,
      objective: state.objective,
      status,
      continuationTurns: state.continuationTurns,
      ...(state.maxContinuationTurns === undefined
        ? {}
        : { maxContinuationTurns: state.maxContinuationTurns }),
      ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason }),
      ...(reason === undefined ? {} : { reason }),
    };
    await this.options.session.recordModeState(GOAL_STATE_KEY, stored as unknown as JsonValue);
  }

  private updateStatus(): void {
    const current = this.goal;
    if (!current) {
      this.options.setStatus(undefined);
    } else if (current.status === "paused") {
      this.options.setStatus("goal paused");
    } else {
      this.options.setStatus(
        `goal ${current.continuationTurns}/${formatLimit(current.maxContinuationTurns)}`,
      );
    }
  }

  private createTool(): ToolDefinition<GoalToolInput> {
    return {
      name: "goal",
      description:
        "Inspect or finish the current autonomous session goal. Use get to recover the complete objective, complete only after every requirement is concretely verified, and drop to abandon it.",
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["get", "complete", "drop"],
            description: "get the full goal, mark a verified goal complete, or abandon it",
          },
        },
        required: ["op"],
        additionalProperties: false,
      },
      parse(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new TypeError("arguments must be an object");
        }
        const object = value as Readonly<Record<string, JsonValue>>;
        if (Object.keys(object).some((key) => key !== "op")) {
          throw new TypeError("only op is allowed");
        }
        if (object.op !== "get" && object.op !== "complete" && object.op !== "drop") {
          throw new TypeError("op must be get, complete, or drop");
        }
        return { op: object.op };
      },
      execute: async (input) => {
        if (input.op === "get") {
          const current = this.goal;
          return {
            content: current
              ? `Status: ${current.status}\nContinuations: ${current.continuationTurns}/${formatLimit(current.maxContinuationTurns)}\nObjective: ${current.objective}`
              : "No goal is set.",
          };
        }

        const finished = await this.finishGoal(
          input.op === "complete" ? "completed" : "dropped",
          "model",
        );
        if (!finished) {
          return {
            content:
              input.op === "complete"
                ? "No goal is set; nothing was completed."
                : "No goal is set; nothing was dropped.",
          };
        }

        this.stopRequested = true;
        if (input.op === "complete") {
          this.options.notify("Goal completed. Automatic continuation stopped.");
          return { content: "Goal marked complete. Automatic continuation is stopped." };
        }
        this.options.notify("Goal dropped by the model. Automatic continuation stopped.");
        return { content: "Goal dropped. Automatic continuation is stopped." };
      },
    };
  }
}

function buildReminder(objective: string): string {
  return `[GOAL MODE ACTIVE — HIDDEN SESSION REMINDER]

Preserve and work toward the complete objective across turns. The objective is reproduced verbatim as a JSON string so none of it is lost:
${JSON.stringify(objective)}

Rules:
- Treat the entire objective above as the persistent goal; do not narrow it to only the most recent step.
- Continue by performing concrete work now. Do not merely narrate that you will continue or describe work you have not done.
- Use the available tools and inspect the current project state before claiming success.
- Check the implementation and run appropriate verification for every concrete requirement.
- Call goal({ op: "complete" }) only after every concrete requirement in the full objective has been implemented and verified.
- Use goal({ op: "get" }) whenever you need to recover the exact objective. Use goal({ op: "drop" }) only when the goal should be abandoned.`;
}

function buildControlMessage(kind: "kickoff" | "continuation"): string {
  return kind === "kickoff"
    ? "Begin concrete work toward the full active objective now. Do not just describe what you intend to do."
    : "Continue concrete work toward the full active objective now. Do not merely say that you will continue.";
}

function formatLimit(limit: number | undefined): string {
  return limit === undefined ? "∞" : String(limit);
}

function parseStoredGoal(value: JsonValue): PersistedGoalState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const state = value as Readonly<Record<string, JsonValue>>;
  if (
    state.version !== 1 ||
    typeof state.objective !== "string" ||
    state.objective.trim().length === 0 ||
    (state.status !== "active" &&
      state.status !== "paused" &&
      state.status !== "completed" &&
      state.status !== "dropped") ||
    typeof state.continuationTurns !== "number" ||
    !Number.isSafeInteger(state.continuationTurns) ||
    state.continuationTurns < 0 ||
    (state.maxContinuationTurns !== undefined &&
      (typeof state.maxContinuationTurns !== "number" ||
        !Number.isSafeInteger(state.maxContinuationTurns) ||
        state.maxContinuationTurns < 0)) ||
    (state.pauseReason !== undefined &&
      state.pauseReason !== "user" &&
      state.pauseReason !== "limit" &&
      state.pauseReason !== "aborted" &&
      state.pauseReason !== "error") ||
    (state.reason !== undefined && typeof state.reason !== "string")
  ) {
    return undefined;
  }
  return state as unknown as PersistedGoalState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
