import { AgentLoop } from "../core/agent-loop.ts";
import { EventBatcher } from "../core/event-batcher.ts";
import type { AgentEvent } from "../core/events.ts";
import type { UiMessage, UiSnapshot, UiToolCard } from "./state.ts";
import { UiStore } from "./state.ts";

export class AgentUiController {
  private readonly unsubscribe: () => void;
  private readonly batcher: EventBatcher<AgentEvent>;
  private activeMessageId: string | undefined;
  private responseSequence = 0;

  constructor(
    private readonly loop: AgentLoop,
    private readonly store: UiStore,
    frameMs = 12,
  ) {
    this.batcher = new EventBatcher((events) => this.consume(events), frameMs);
    this.unsubscribe = loop.subscribe((event) => this.batcher.push(event));
  }

  async submit(text: string): Promise<void> {
    this.store.update({ busy: true, status: "responding" });
    await this.loop.submit(text);
  }

  async steer(text: string): Promise<void> {
    this.store.update({ busy: true, status: "steering" });
    await this.loop.steer(text);
  }

  cancel(): void {
    this.loop.cancel();
  }

  dispose(): void {
    this.unsubscribe();
    this.batcher.flush();
  }

  private consume(events: readonly AgentEvent[]): void {
    let snapshot = this.store.snapshot;
    let messages = [...snapshot.messages];
    let contextTokens = snapshot.contextTokens;
    let cost = snapshot.cost;
    let busy = snapshot.busy;
    let status = snapshot.status;

    const replaceMessage = (id: string, patch: Partial<UiMessage>): void => {
      const index = messages.findIndex((message) => message.id === id);
      const current = messages[index];
      if (index === -1 || !current) return;
      messages[index] = { ...current, ...patch };
    };

    const activeMessage = (): UiMessage | undefined =>
      messages.find((message) => message.id === this.activeMessageId);

    for (const event of events) {
      switch (event.type) {
        case "user_message":
          messages.push({
            id: crypto.randomUUID(),
            role: "user",
            content: event.message.content,
          });
          busy = true;
          status = "responding";
          break;
        case "response_start": {
          const active = activeMessage();
          if (
            active?.streaming &&
            active.content.length === 0 &&
            !active.thinking &&
            !active.tools?.length
          ) {
            break;
          }
          const suffix = this.responseSequence++;
          this.activeMessageId = event.id ? `${event.id}:${suffix}` : crypto.randomUUID();
          messages.push({
            id: this.activeMessageId,
            role: "assistant",
            content: "",
            streaming: true,
          });
          busy = true;
          status = "streaming";
          break;
        }
        case "text_delta": {
          const active = activeMessage();
          if (active) replaceMessage(active.id, { content: active.content + event.delta });
          break;
        }
        case "thinking_delta": {
          const active = activeMessage();
          if (active) {
            replaceMessage(active.id, { thinking: (active.thinking ?? "") + event.delta });
          }
          break;
        }
        case "tool_call_start": {
          const active = activeMessage();
          if (!active) break;
          replaceMessage(active.id, {
            tools: upsertCard(active.tools, {
              id: event.id,
              name: event.name,
              status: "pending",
            }),
          });
          status = `tool · ${event.name}`;
          break;
        }
        case "tool_call_delta":
        case "tool_call_end":
          break;
        case "usage":
          contextTokens += event.usage.inputTokens + event.usage.outputTokens;
          cost += event.usage.cost ?? 0;
          break;
        case "response_end": {
          const active = activeMessage();
          if (active) replaceMessage(active.id, { streaming: false });
          status = active?.tools?.length ? "running tools" : "finishing";
          break;
        }
        case "assistant_message": {
          const active = activeMessage();
          if (!active) break;
          replaceMessage(active.id, {
            content: event.message.content,
            ...(event.message.thinking === undefined ? {} : { thinking: event.message.thinking }),
            streaming: false,
          });
          break;
        }
        case "tool_execution_start": {
          const ownerIndex = findToolOwner(messages, event.id);
          const owner = messages[ownerIndex];
          const card = owner?.tools?.find((candidate) => candidate.id === event.id);
          if (!owner || !card) break;
          messages[ownerIndex] = {
            ...owner,
            tools: upsertCard(owner.tools, { ...card, status: "running" }),
          };
          status = `tool · ${event.name}`;
          break;
        }
        case "tool_execution_output": {
          const ownerIndex = findToolOwner(messages, event.id);
          const owner = messages[ownerIndex];
          const card = owner?.tools?.find((candidate) => candidate.id === event.id);
          if (!owner || !card) break;
          const output = `${card.output ?? ""}${event.delta}`.slice(-4_000);
          messages[ownerIndex] = {
            ...owner,
            tools: upsertCard(owner.tools, {
              ...card,
              status: "running",
              output,
              summary: summarize(output),
            }),
          };
          break;
        }
        case "tool_execution_end": {
          const ownerIndex = findToolOwner(messages, event.id);
          const owner = messages[ownerIndex];
          const card = owner?.tools?.find((candidate) => candidate.id === event.id);
          if (!owner || !card) break;
          messages[ownerIndex] = {
            ...owner,
            tools: upsertCard(owner.tools, {
              ...card,
              status: event.isError ? "failed" : "completed",
            }),
          };
          break;
        }
        case "tool_result": {
          const ownerIndex = findToolOwner(messages, event.message.toolCallId);
          const owner = messages[ownerIndex];
          if (!owner) break;
          const card = owner.tools?.find((candidate) => candidate.id === event.message.toolCallId);
          if (!card) break;
          const updated: UiToolCard = {
            ...card,
            status: event.message.isError ? "failed" : "completed",
            summary: summarize(event.message.content),
            output: event.message.content,
          };
          const tools = upsertCard(owner.tools, updated);
          messages[ownerIndex] = { ...owner, tools };
          status = event.message.isError ? `tool failed · ${event.message.name}` : "responding";
          break;
        }
        case "error": {
          const active = activeMessage();
          if (active) {
            replaceMessage(active.id, {
              streaming: false,
              error: event.error.message,
            });
          }
          busy = false;
          status = event.error.kind === "auth" ? "login required" : event.error.kind;
          break;
        }
        case "cancelled": {
          const active = activeMessage();
          if (active) replaceMessage(active.id, { streaming: false, error: "Cancelled" });
          busy = false;
          status = "cancelled";
          break;
        }
        case "idle":
          busy = false;
          if (status !== "cancelled" && status !== "login required") status = "ready";
          this.activeMessageId = undefined;
          break;
      }
    }

    snapshot = { ...snapshot, messages, contextTokens, cost, busy, status } satisfies UiSnapshot;
    this.store.update(snapshot);
  }
}

function upsertCard(cards: readonly UiToolCard[] | undefined, card: UiToolCard): UiToolCard[] {
  const next = [...(cards ?? [])];
  const index = next.findIndex((candidate) => candidate.id === card.id);
  if (index === -1) next.push(card);
  else next[index] = card;
  return next;
}

function findToolOwner(messages: readonly UiMessage[], callId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.tools?.some((tool) => tool.id === callId)) return index;
  }
  return -1;
}

function summarize(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const normalized = firstLine.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 97)}...`;
}
