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
  thinkingExpanded?: boolean;
  streaming?: boolean;
  error?: string;
  tools?: UiToolCard[];
}

export type UiAgentStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";

export interface UiAgentTranscriptLine {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface UiAgentIndicator {
  id: string;
  description: string;
  provider: string;
  model: string;
  mode: "research" | "patch";
  status: UiAgentStatus;
  inputTokens: number;
  outputTokens: number;
  childSessionId: string;
  transcript?: readonly UiAgentTranscriptLine[];
  summary?: string;
  error?: string;
}

export interface UiAgentPanelState {
  view: "list" | "detail";
  selectedAgentId: string;
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
  agentPanel?: UiAgentPanelState;
  approval?: UiApprovalPrompt;
  picker?: UiPickerPrompt;
  notice?: string;
}

export type UiListener = (snapshot: UiSnapshot) => void;
export type UiApprovalDecisionHandler = (id: string, decision: UiApprovalDecision) => void;
export type UiPickerDecisionHandler = (id: string, optionId: string | undefined) => void;
export type UiAgentDecision = "open" | "cancel";
export type UiAgentDecisionHandler = (id: string, decision: UiAgentDecision) => void;

export class UiStore {
  private current: UiSnapshot;
  private readonly listeners = new Set<UiListener>();
  private approvalDecisionHandler: UiApprovalDecisionHandler | undefined;
  private pickerDecisionHandler: UiPickerDecisionHandler | undefined;
  private agentDecisionHandler: UiAgentDecisionHandler | undefined;

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

  toggleLatestDisclosure(): boolean {
    const messages = [...this.current.messages];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (!message) continue;
      const tools = [...(message.tools ?? [])];
      for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const tool = tools[toolIndex];
        if (!tool || (!tool.output && !tool.diff)) continue;
        tools[toolIndex] = { ...tool, expanded: !tool.expanded };
        messages[messageIndex] = { ...message, tools };
        this.publish({ ...this.current, messages });
        return true;
      }
      if (message.thinking) {
        messages[messageIndex] = {
          ...message,
          thinkingExpanded: !message.thinkingExpanded,
        };
        this.publish({ ...this.current, messages });
        return true;
      }
    }
    return false;
  }

  upsertAgent(agent: UiAgentIndicator): void {
    const agents = [...this.current.agents];
    const index = agents.findIndex((candidate) => candidate.id === agent.id);
    if (index === -1) agents.push(agent);
    else agents[index] = agent;
    this.publish({ ...this.current, agents });
  }

  removeAgent(id: string): void {
    const index = this.current.agents.findIndex((agent) => agent.id === id);
    if (index === -1) return;

    const agents = this.current.agents.filter((agent) => agent.id !== id);
    if (agents.length === 0) {
      const { agentPanel: _agentPanel, ...snapshot } = this.current;
      this.publish({ ...snapshot, agents });
      return;
    }

    const panel = this.current.agentPanel;
    if (panel?.selectedAgentId !== id) {
      this.publish({ ...this.current, agents });
      return;
    }

    const replacement = agents[Math.min(index, agents.length - 1)];
    if (!replacement) return;
    this.publish({
      ...this.current,
      agents,
      agentPanel: { view: "list", selectedAgentId: replacement.id },
    });
  }

  openAgents(): boolean {
    const selectedAgentId = this.current.agentPanel?.selectedAgentId ?? this.current.agents[0]?.id;
    if (!selectedAgentId) return false;
    this.publish({
      ...this.current,
      agentPanel: { view: "list", selectedAgentId },
    });
    return true;
  }

  selectAgent(id: string): boolean {
    if (!this.current.agents.some((agent) => agent.id === id)) return false;
    this.publish({
      ...this.current,
      agentPanel: { view: "list", selectedAgentId: id },
    });
    return true;
  }

  moveAgentSelection(delta: number): void {
    const panel = this.current.agentPanel;
    if (!panel || panel.view !== "list" || this.current.agents.length === 0 || delta === 0) return;
    const selectedIndex = this.current.agents.findIndex(
      (agent) => agent.id === panel.selectedAgentId,
    );
    const nextIndex =
      (Math.max(0, selectedIndex) + delta + this.current.agents.length) %
      this.current.agents.length;
    const agent = this.current.agents[nextIndex];
    if (agent) this.selectAgent(agent.id);
  }

  openAgent(id: string): boolean {
    if (!this.current.agents.some((agent) => agent.id === id)) return false;
    this.publish({
      ...this.current,
      agentPanel: { view: "detail", selectedAgentId: id },
    });
    this.agentDecisionHandler?.(id, "open");
    return true;
  }

  openSelectedAgent(): boolean {
    const panel = this.current.agentPanel;
    return panel ? this.openAgent(panel.selectedAgentId) : false;
  }

  cancelSelectedAgent(): boolean {
    const panel = this.current.agentPanel;
    const handler = this.agentDecisionHandler;
    if (!panel || !handler) return false;
    handler(panel.selectedAgentId, "cancel");
    return true;
  }

  backAgentPanel(): void {
    const panel = this.current.agentPanel;
    if (!panel) return;
    if (panel.view === "detail") {
      this.publish({ ...this.current, agentPanel: { ...panel, view: "list" } });
    } else {
      this.clearAgentSelection();
    }
  }

  clearAgentSelection(): void {
    if (!this.current.agentPanel) return;
    const { agentPanel: _agentPanel, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  setAgentDecisionHandler(handler: UiAgentDecisionHandler): () => void {
    if (this.agentDecisionHandler) {
      throw new Error("An agent decision handler is already registered");
    }
    this.agentDecisionHandler = handler;
    return () => {
      if (this.agentDecisionHandler === handler) this.agentDecisionHandler = undefined;
    };
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
