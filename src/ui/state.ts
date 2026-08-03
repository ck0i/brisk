export type UiMessageRole = "user" | "assistant" | "system";

export interface UiToolCard {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  output?: string;
  diff?: string;
  expanded?: boolean;
}

export interface UiMessage {
  id: string;
  role: UiMessageRole;
  content: string;
  thinking?: string;
  streaming?: boolean;
  error?: string;
  tools?: UiToolCard[];
}

export interface UiAgentIndicator {
  id: string;
  description: string;
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  mode: "research" | "patch";
  model: string;
}

export interface UiSnapshot {
  workspace: string;
  providerModel: string;
  status: string;
  mode: "safe" | "write" | "yolo";
  contextTokens: number;
  contextWindow: number | undefined;
  cost: number;
  busy: boolean;
  messages: readonly UiMessage[];
  agents: readonly UiAgentIndicator[];
  notice?: string;
}

export type UiListener = (snapshot: UiSnapshot) => void;

export class UiStore {
  private current: UiSnapshot;
  private readonly listeners = new Set<UiListener>();

  constructor(workspace: string, mode: UiSnapshot["mode"] = "write") {
    this.current = {
      workspace,
      providerModel: "select a model",
      status: "ready",
      mode,
      contextTokens: 0,
      contextWindow: undefined,
      cost: 0,
      busy: false,
      messages: [],
      agents: [],
    };
  }

  get snapshot(): UiSnapshot {
    return this.current;
  }

  subscribe(listener: UiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<UiSnapshot>): void {
    this.publish({ ...this.current, ...patch });
  }

  addMessage(message: UiMessage): void {
    this.publish({ ...this.current, messages: [...this.current.messages, message] });
  }

  replaceMessage(id: string, update: Partial<UiMessage>): void {
    const index = this.current.messages.findIndex((message) => message.id === id);
    if (index === -1) return;

    const messages = [...this.current.messages];
    const message = messages[index];
    if (!message) return;
    messages[index] = { ...message, ...update };
    this.publish({ ...this.current, messages });
  }

  appendMessageText(id: string, text: string): void {
    const message = this.current.messages.find((candidate) => candidate.id === id);
    if (!message || text.length === 0) return;
    this.replaceMessage(id, { content: message.content + text });
  }

  appendMessageThinking(id: string, text: string): void {
    const message = this.current.messages.find((candidate) => candidate.id === id);
    if (!message || text.length === 0) return;
    this.replaceMessage(id, { thinking: (message.thinking ?? "") + text });
  }

  upsertToolCard(messageId: string, card: UiToolCard): void {
    const message = this.current.messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    const tools = [...(message.tools ?? [])];
    const index = tools.findIndex((candidate) => candidate.id === card.id);
    if (index === -1) tools.push(card);
    else tools[index] = { ...tools[index], ...card };
    this.replaceMessage(messageId, { tools });
  }

  clearMessages(): void {
    this.publish({ ...this.current, messages: [] });
  }

  private publish(snapshot: UiSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
