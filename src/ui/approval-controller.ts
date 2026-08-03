import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../tools/approval.ts";
import type { UiApprovalDecision } from "./state.ts";
import { UiStore } from "./state.ts";

interface PendingApproval {
  readonly id: string;
  readonly request: ApprovalRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly onAbort: () => void;
}

/** Bridges headless approval requests to a single serialized UI prompt. */
export class UiApprovalController implements ApprovalHandler {
  private readonly pending: PendingApproval[] = [];
  private readonly removeDecisionHandler: () => void;
  private active: PendingApproval | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly store: UiStore) {
    this.removeDecisionHandler = store.setApprovalDecisionHandler((id, decision) => {
      this.resolveFromUi(id, decision);
    });
  }

  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (this.disposed || signal?.aborted) return Promise.resolve("deny");

    return new Promise((resolve) => {
      const id = `approval-${this.sequence++}`;
      const item: PendingApproval = {
        id,
        request,
        signal,
        resolve,
        onAbort: () => this.abort(id),
      };
      this.pending.push(item);
      signal?.addEventListener("abort", item.onAbort, { once: true });
      if (signal?.aborted) this.abort(id);
      else this.publishNext();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDecisionHandler();

    const unresolved = [...(this.active ? [this.active] : []), ...this.pending];
    this.active = undefined;
    this.pending.length = 0;
    this.store.clearApproval();
    for (const item of unresolved) this.settle(item, "deny");
  }

  private resolveFromUi(id: string, decision: UiApprovalDecision): void {
    const item = this.active;
    if (!item || item.id !== id) return;
    this.active = undefined;
    this.store.clearApproval(id);
    this.settle(item, decision);
    this.publishNext();
  }

  private abort(id: string): void {
    if (this.active?.id === id) {
      const item = this.active;
      this.active = undefined;
      this.store.clearApproval(id);
      this.settle(item, "deny");
      this.publishNext();
      return;
    }

    const index = this.pending.findIndex((item) => item.id === id);
    if (index === -1) return;
    const [item] = this.pending.splice(index, 1);
    if (item) this.settle(item, "deny");
  }

  private publishNext(): void {
    if (this.disposed || this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    if (item.signal?.aborted) {
      this.settle(item, "deny");
      this.publishNext();
      return;
    }

    this.active = item;
    this.store.showApproval({
      id: item.id,
      toolName: item.request.toolName,
      summary: item.request.summary,
      ...(item.request.command === undefined ? {} : { command: item.request.command }),
      ...(item.request.diff === undefined ? {} : { diff: item.request.diff }),
      targetPaths: [...item.request.targetPaths],
      riskDescription: item.request.riskDescription,
      equivalenceKey: item.request.equivalenceKey,
    });
  }

  private settle(item: PendingApproval, decision: ApprovalDecision): void {
    item.signal?.removeEventListener("abort", item.onAbort);
    item.resolve(decision);
  }
}
