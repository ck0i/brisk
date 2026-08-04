import type { AgentLoop } from "../core/agent-loop.ts";

interface ActiveLoop {
  readonly prompt: string;
  readonly limit?: number;
  iteration: number;
}

export interface LoopRuntimeOptions {
  readonly notify: (message: string) => void;
  readonly setStatus: (status: string | undefined) => void;
}

/** First-class `/loop` state machine, scoped to the currently attached root agent. */
export class LoopRuntime {
  private armed = false;
  private armedLimit: number | undefined;
  private activeLoop: ActiveLoop | undefined;
  private failedReason: "aborted" | "error" | undefined;
  private unsubscribe: (() => void) | undefined;
  private submitFollowUp: ((prompt: string) => Promise<void>) | undefined;

  constructor(private readonly options: LoopRuntimeOptions) {}

  get active(): boolean {
    return this.armed || this.activeLoop !== undefined;
  }

  attach(loop: AgentLoop, submitFollowUp: (prompt: string) => Promise<void>): void {
    this.detach();
    this.submitFollowUp = submitFollowUp;
    this.unsubscribe = loop.subscribe((event) => {
      if (!this.activeLoop) return;
      if (event.type === "cancelled") this.failedReason = "aborted";
      else if (event.type === "error") this.failedReason = "error";
      else if (event.type === "idle") this.handleSettled();
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.submitFollowUp = undefined;
    this.clear();
  }

  execute(argumentValue: string, _idle = true): void {
    const argument = argumentValue.trim().toLowerCase();
    if (argument === "stop") {
      const wasRunning = this.active;
      this.clear();
      this.options.notify(wasRunning ? "Loop stopped." : "No loop is active.");
      return;
    }

    if (argument === "status") {
      const current = this.activeLoop;
      if (current) {
        this.options.notify(
          `Loop is running iteration ${current.iteration} of ${targetLabel(current.limit)}.`,
        );
      } else if (this.armed) {
        this.options.notify(
          `Loop is waiting for the next prompt (${targetLabel(this.armedLimit)} runs).`,
        );
      } else {
        this.options.notify("No loop is active.");
      }
      return;
    }

    let limit: number | undefined;
    if (argument) {
      if (!/^[1-9]\d*$/.test(argument)) {
        this.options.notify("Usage: /loop [positive-integer], /loop stop, or /loop status");
        return;
      }
      limit = Number(argument);
      if (!Number.isSafeInteger(limit)) {
        this.options.notify("Loop count is too large.");
        return;
      }
    }

    if (this.activeLoop) {
      this.options.notify("A loop is already running. Use /loop stop first.");
      return;
    }

    this.armed = true;
    this.armedLimit = limit;
    this.updateStatus();
    this.options.notify(
      limit === undefined
        ? "Loop armed. The next prompt will repeat until stopped."
        : `Loop armed. The next prompt will run ${limit} time${limit === 1 ? "" : "s"} total.`,
    );
  }

  /** Capture exactly the user prompt accepted by Brisk, before the first run starts. */
  capturePrompt(prompt: string): void {
    if (!this.armed || this.activeLoop) return;
    this.activeLoop = {
      prompt,
      ...(this.armedLimit === undefined ? {} : { limit: this.armedLimit }),
      iteration: 1,
    };
    this.armed = false;
    this.armedLimit = undefined;
    this.failedReason = undefined;
    this.updateStatus();
  }

  private handleSettled(): void {
    const current = this.activeLoop;
    if (!current) return;

    const failedReason = this.failedReason;
    this.failedReason = undefined;
    if (failedReason) {
      this.clear();
      this.options.notify(`Loop stopped because the agent run ${failedReason}.`);
      return;
    }

    if (current.limit !== undefined && current.iteration >= current.limit) {
      const completed = current.iteration;
      this.clear();
      this.options.notify(`Loop complete after ${completed} run${completed === 1 ? "" : "s"}.`);
      return;
    }

    const submit = this.submitFollowUp;
    if (!submit) {
      this.clear();
      return;
    }
    current.iteration += 1;
    this.updateStatus();
    void submit(current.prompt).catch(() => {
      // Agent errors and cancellations are observed through the loop event stream.
    });
  }

  private clear(): void {
    this.armed = false;
    this.armedLimit = undefined;
    this.activeLoop = undefined;
    this.failedReason = undefined;
    this.updateStatus();
  }

  private updateStatus(): void {
    const current = this.activeLoop;
    if (current) {
      this.options.setStatus(`loop ${current.iteration}/${targetLabel(current.limit)}`);
    } else if (this.armed) {
      this.options.setStatus(`loop waiting/${targetLabel(this.armedLimit)}`);
    } else {
      this.options.setStatus(undefined);
    }
  }
}

function targetLabel(limit: number | undefined): string {
  return limit === undefined ? "∞" : String(limit);
}
