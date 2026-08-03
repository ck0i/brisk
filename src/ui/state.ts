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

export interface UiApprovalPrompt {
  id: string;
  toolName: string;
  summary: string;
  command?: string;
  diff?: string;
  targetPaths: readonly string[];
  riskDescription: string;
  equivalenceKey: string;
}

export type UiApprovalDecision = "approve_once" | "approve_session" | "deny";

export interface UiPickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface UiPickerPrompt {
  id: string;
  title: string;
  options: readonly UiPickerOption[];
  selectedIndex: number;
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
  approval?: UiApprovalPrompt;
  picker?: UiPickerPrompt;
  notice?: string;
}

export type UiListener = (snapshot: UiSnapshot) => void;
export type UiApprovalDecisionHandler = (id: string, decision: UiApprovalDecision) => void;
export type UiPickerDecisionHandler = (id: string, optionId: string | undefined) => void;

export class UiStore {
  private current: UiSnapshot;
  private readonly listeners = new Set<UiListener>();
  private approvalDecisionHandler: UiApprovalDecisionHandler | undefined;
  private pickerDecisionHandler: UiPickerDecisionHandler | undefined;

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

  showApproval(approval: UiApprovalPrompt): void {
    this.publish({ ...this.current, approval });
  }

  clearApproval(id?: string): void {
    if (!this.current.approval || (id !== undefined && this.current.approval.id !== id)) return;
    const { approval: _approval, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  setApprovalDecisionHandler(handler: UiApprovalDecisionHandler): () => void {
    if (this.approvalDecisionHandler) {
      throw new Error("An approval decision handler is already registered");
    }
    this.approvalDecisionHandler = handler;
    return () => {
      if (this.approvalDecisionHandler === handler) this.approvalDecisionHandler = undefined;
    };
  }

  decideApproval(decision: UiApprovalDecision): boolean {
    const approval = this.current.approval;
    const handler = this.approvalDecisionHandler;
    if (!approval || !handler) return false;
    handler(approval.id, decision);
    return true;
  }

  showPicker(picker: UiPickerPrompt): void {
    this.publish({ ...this.current, picker });
  }

  movePicker(delta: number): void {
    const picker = this.current.picker;
    if (!picker || picker.options.length === 0 || delta === 0) return;
    let index = picker.selectedIndex;
    for (let attempt = 0; attempt < picker.options.length; attempt += 1) {
      index = (index + delta + picker.options.length) % picker.options.length;
      if (!picker.options[index]?.disabled) break;
    }
    this.publish({ ...this.current, picker: { ...picker, selectedIndex: index } });
  }

  decidePicker(select: boolean): boolean {
    const picker = this.current.picker;
    const handler = this.pickerDecisionHandler;
    if (!picker || !handler) return false;
    const option = select ? picker.options[picker.selectedIndex] : undefined;
    if (option?.disabled) return false;
    handler(picker.id, option?.id);
    return true;
  }

  clearPicker(id?: string): void {
    if (!this.current.picker || (id !== undefined && this.current.picker.id !== id)) return;
    const { picker: _picker, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  setPickerDecisionHandler(handler: UiPickerDecisionHandler): () => void {
    if (this.pickerDecisionHandler)
      throw new Error("A picker decision handler is already registered");
    this.pickerDecisionHandler = handler;
    return () => {
      if (this.pickerDecisionHandler === handler) this.pickerDecisionHandler = undefined;
    };
  }

  private publish(snapshot: UiSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
