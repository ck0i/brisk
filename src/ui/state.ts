import { rankPickerOptions } from "./picker-search.ts";

export type UiMessageRole = "user" | "assistant" | "system";
export type UiTheme = "default" | "high-contrast";

export interface UiToolCard {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  output?: string;
  diff?: string;
  targetPaths?: readonly string[];
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
  errorExpanded?: boolean;
  tools?: UiToolCard[];
}

export type UiAgentStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";

export type UiExtensionSlot = "header" | "sidebar" | "status" | "composer";

export interface UiExtensionContribution {
  id: string;
  slot: UiExtensionSlot;
  text: string;
  priority?: number;
}

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
  activityEvents?: number;
  childSessionId: string;
  transcript?: readonly UiAgentTranscriptLine[];
  summary?: string;
  error?: string;
}

export interface UiAgentPanelState {
  view: "list" | "detail";
  selectedAgentId: string;
}

export interface UiBtwMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
}

export interface UiBtwState {
  id: string;
  model: string;
  status: string;
  busy: boolean;
  messages: readonly UiBtwMessage[];
  activeTools: readonly string[];
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
  searchText?: string;
  disabled?: boolean;
}

export interface UiPickerPrompt {
  id: string;
  title: string;
  options: readonly UiPickerOption[];
  selectedIndex: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  query?: string;
}

export interface UiTextInputPrompt {
  id: string;
  title: string;
  message: string;
  value: string;
  placeholder?: string;
  error?: string;
}

export interface UiAuthPrompt {
  id: string;
  provider: string;
  message?: string;
  placeholder?: string;
  instructions?: string;
  browserStatus?: string;
  progress?: string;
  input: string;
  inputId: number;
  allowEmpty: boolean;
  error?: string;
}

export interface UiSnapshot {
  workspace: string;
  providerModel: string;
  effort: string;
  status: string;
  mode: "safe" | "write" | "yolo";
  theme: UiTheme;
  showThinking: boolean;
  contextTokens: number;
  contextWindow: number | undefined;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  busy: boolean;
  messages: readonly UiMessage[];
  agents: readonly UiAgentIndicator[];
  extensionUi: readonly UiExtensionContribution[];
  extensionKeybindings: readonly string[];
  loopStatus: string | undefined;
  goalStatus: string | undefined;
  btw?: UiBtwState;
  agentPanel?: UiAgentPanelState;
  approval?: UiApprovalPrompt;
  picker?: UiPickerPrompt;
  textInput?: UiTextInputPrompt;
  auth?: UiAuthPrompt;
  notice?: string;
  noticeExpanded?: boolean;
}

export type UiListener = (snapshot: UiSnapshot) => void;
export type UiApprovalDecisionHandler = (id: string, decision: UiApprovalDecision) => void;
export type UiPickerDecisionHandler = (id: string, optionId: string | undefined) => void;
export type UiTextInputDecisionHandler = (id: string, value: string | undefined) => void;
export type UiAuthDecisionHandler = (id: string, value: string | undefined) => void;
export type UiAgentDecision = "open" | "cancel";
export type UiAgentDecisionHandler = (id: string, decision: UiAgentDecision) => void;
export type UiBtwDecision =
  { readonly type: "ask"; readonly question: string } | { readonly type: "close" };
export type UiBtwDecisionHandler = (id: string, decision: UiBtwDecision) => boolean | void;

export class UiStore {
  private current: UiSnapshot;
  private readonly listeners = new Set<UiListener>();
  private approvalDecisionHandler: UiApprovalDecisionHandler | undefined;
  private pickerDecisionHandler: UiPickerDecisionHandler | undefined;
  private textInputDecisionHandler: UiTextInputDecisionHandler | undefined;
  private authDecisionHandler: UiAuthDecisionHandler | undefined;
  private agentDecisionHandler: UiAgentDecisionHandler | undefined;
  private btwDecisionHandler: UiBtwDecisionHandler | undefined;

  constructor(workspace: string, mode: UiSnapshot["mode"] = "write") {
    this.current = {
      workspace,
      providerModel: "select a model",
      effort: "auto",
      status: "ready",
      mode,
      theme: "default",
      showThinking: false,
      contextTokens: 0,
      contextWindow: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      busy: false,
      messages: [],
      agents: [],
      extensionUi: [],
      loopStatus: undefined,
      goalStatus: undefined,
      extensionKeybindings: [],
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

  clearNotice(): void {
    if (this.current.notice === undefined) return;
    const { notice: _notice, noticeExpanded: _noticeExpanded, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  toggleLatestDisclosure(): boolean {
    if (this.current.notice && this.current.notice.length > 240) {
      this.publish({
        ...this.current,
        noticeExpanded: !this.current.noticeExpanded,
      });
      return true;
    }
    const messages = [...this.current.messages];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (!message) continue;
      if (message.error && message.error.length > 240) {
        messages[messageIndex] = {
          ...message,
          errorExpanded: !message.errorExpanded,
        };
        this.publish({ ...this.current, messages });
        return true;
      }
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
          thinkingExpanded: !(message.thinkingExpanded ?? this.current.showThinking),
        };
        this.publish({ ...this.current, messages });
        return true;
      }
    }
    return false;
  }

  setExtensionUi(contributions: readonly UiExtensionContribution[]): void {
    this.publish({ ...this.current, extensionUi: [...contributions] });
  }

  setExtensionKeybindings(keybindings: readonly string[]): void {
    this.publish({ ...this.current, extensionKeybindings: [...keybindings] });
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

  showBtw(btw: UiBtwState): void {
    this.publish({ ...this.current, btw });
  }

  updateBtw(id: string, patch: Partial<UiBtwState>): void {
    const current = this.current.btw;
    if (!current || current.id !== id) return;
    this.publish({ ...this.current, btw: { ...current, ...patch } });
  }

  clearBtw(id?: string): void {
    if (!this.current.btw || (id !== undefined && this.current.btw.id !== id)) return;
    const { btw: _btw, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  decideBtw(decision: UiBtwDecision): boolean {
    const btw = this.current.btw;
    const handler = this.btwDecisionHandler;
    if (!btw || !handler) return false;
    return handler(btw.id, decision) !== false;
  }

  setBtwDecisionHandler(handler: UiBtwDecisionHandler): () => void {
    if (this.btwDecisionHandler) throw new Error("A BTW decision handler is already registered");
    this.btwDecisionHandler = handler;
    return () => {
      if (this.btwDecisionHandler === handler) this.btwDecisionHandler = undefined;
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
    const rows = rankPickerOptions(picker.options, picker.searchable ? picker.query : undefined);
    if (rows.length === 0) return;
    let position = rows.findIndex((row) => row.index === picker.selectedIndex);
    for (let attempt = 0; attempt < rows.length; attempt += 1) {
      position = (position + delta + rows.length) % rows.length;
      const row = rows[position];
      if (!row || row.option.disabled) continue;
      this.publish({
        ...this.current,
        picker: { ...picker, selectedIndex: row.index },
      });
      return;
    }
  }

  setPickerQuery(query: string): void {
    const picker = this.current.picker;
    if (!picker?.searchable || picker.query === query) return;
    const nextPicker = { ...picker, query };
    const selectedIndex =
      rankPickerOptions(picker.options, query).find((row) => !row.option.disabled)?.index ?? -1;
    this.publish({ ...this.current, picker: { ...nextPicker, selectedIndex } });
  }

  decidePicker(select: boolean): boolean {
    const picker = this.current.picker;
    const handler = this.pickerDecisionHandler;
    if (!picker || !handler) return false;
    if (!select) {
      handler(picker.id, undefined);
      return true;
    }
    const option = picker.options[picker.selectedIndex];
    if (!option || option.disabled) return false;
    handler(picker.id, option.id);
    return true;
  }

  clearPicker(id?: string): void {
    if (!this.current.picker || (id !== undefined && this.current.picker.id !== id)) return;
    const { picker: _picker, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  showTextInput(textInput: UiTextInputPrompt): void {
    this.publish({ ...this.current, textInput });
  }

  clearTextInput(id?: string): void {
    if (!this.current.textInput || (id !== undefined && this.current.textInput.id !== id)) return;
    const { textInput: _textInput, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  decideTextInput(value: string | undefined): boolean {
    const textInput = this.current.textInput;
    const handler = this.textInputDecisionHandler;
    if (!textInput || !handler) return false;
    handler(textInput.id, value);
    return true;
  }

  setTextInputDecisionHandler(handler: UiTextInputDecisionHandler): () => void {
    if (this.textInputDecisionHandler) {
      throw new Error("A text input decision handler is already registered");
    }
    this.textInputDecisionHandler = handler;
    return () => {
      if (this.textInputDecisionHandler === handler) this.textInputDecisionHandler = undefined;
    };
  }

  showAuth(auth: UiAuthPrompt): void {
    this.publish({ ...this.current, auth });
  }

  clearAuth(id?: string): void {
    if (!this.current.auth || (id !== undefined && this.current.auth.id !== id)) return;
    const { auth: _auth, ...snapshot } = this.current;
    this.publish(snapshot);
  }

  decideAuth(value: string | undefined): boolean {
    const auth = this.current.auth;
    const handler = this.authDecisionHandler;
    if (!auth || !handler) return false;
    handler(auth.id, value);
    return true;
  }

  setAuthDecisionHandler(handler: UiAuthDecisionHandler): () => void {
    if (this.authDecisionHandler) throw new Error("An auth decision handler is already registered");
    this.authDecisionHandler = handler;
    return () => {
      if (this.authDecisionHandler === handler) this.authDecisionHandler = undefined;
    };
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
