import { AgentLoop } from "../core/agent-loop.ts";
import type { AgentEvent } from "../core/events.ts";
import type { Message } from "../core/messages.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { UiBtwMessage, UiStore } from "../ui/state.ts";

const SIDE_AGENT_INSTRUCTIONS = `# BTW side agent

You are a private, independent side agent answering questions about an active main coding-agent conversation.

Rules for this side channel:
- The main agent continues independently and cannot see this conversation. Never address, steer, or report back to it.
- Answer the side question directly and concisely using the copied main-chat context and live-status metadata.
- The copied context is a snapshot. Clearly distinguish completed work, work in progress, and uncertain or remaining work.
- You are strictly read-only. You may inspect the project with read, search, find, and list, but must never modify files or run shell commands.
- Do not take over the main task. If asked to make a change, explain that the side channel is read-only.
- Do not expose hidden reasoning or chain-of-thought. Give conclusions and brief supporting evidence only.
- Paths should be reported relative to the project when practical.

These BTW rules override any conflicting workflow or tool instructions copied from the main system prompt.`;

const MAX_LIVE_TEXT = 2_500;
const MAX_UPDATE_TEXT = 12_000;
const MAX_ENTRY_TEXT = 2_000;

export interface BtwProviderSelection {
  readonly provider: Provider;
  readonly model: string;
  readonly label: string;
}

export interface BtwRuntimeOptions {
  readonly store: UiStore;
  readonly createProvider: (threadId: string) => BtwProviderSelection;
  readonly createTools: (threadId: string) => Promise<ToolRegistry>;
  readonly createContext: (signal: AbortSignal) => Promise<readonly Message[]>;
  readonly getMainMessages: () => readonly Message[];
  readonly getLiveStatus: () => string;
  readonly additionalSystemPrompt: () => readonly string[];
  readonly onCost?: (cost: number) => void | Promise<void>;
}

interface ActiveThread {
  readonly id: string;
  readonly provider: Provider;
  readonly loop: AgentLoop;
  unsubscribe: () => void;
  readonly model: string;
  mainMessageCount: number;
  currentAssistantId: string | undefined;
  currentRun: Promise<void> | undefined;
  cost: number;
  lengthLimited: boolean;
  closed: boolean;
}

/** Owns one private, read-only side thread while the root loop continues independently. */
export class BtwRuntime {
  private active: ActiveThread | undefined;
  private readonly removeDecisionHandler: () => void;

  constructor(private readonly options: BtwRuntimeOptions) {
    this.removeDecisionHandler = options.store.setBtwDecisionHandler((id, decision) => {
      const thread = this.active;
      if (!thread || thread.id !== id) return false;
      if (decision.type === "close") {
        void this.closeThread(thread);
        return true;
      }
      if (this.options.store.snapshot.btw?.busy) return false;
      this.ask(thread, decision.question);
      return true;
    });
  }

  get open(): boolean {
    return this.active !== undefined;
  }

  async start(initialQuestionValue: string): Promise<boolean> {
    const initialQuestion = initialQuestionValue.trim();
    if (!initialQuestion) return false;
    if (this.active) return false;

    const id = `btw-${crypto.randomUUID()}`;
    const selection = this.options.createProvider(id);
    let tools: ToolRegistry;
    let context: readonly Message[];
    try {
      [tools, context] = await Promise.all([
        this.options.createTools(id),
        this.options.createContext(new AbortController().signal),
      ]);
    } catch (error) {
      selection.provider.close?.();
      throw error;
    }
    const loop = new AgentLoop({
      provider: selection.provider,
      model: selection.model,
      tools,
      initialMessages: context,
      additionalSystemPrompt: this.options.additionalSystemPrompt(),
      sessionRolePrompt: SIDE_AGENT_INSTRUCTIONS,
    });
    const thread: ActiveThread = {
      id,
      provider: selection.provider,
      loop,
      unsubscribe: () => undefined,
      model: selection.label,
      mainMessageCount: this.options.getMainMessages().length,
      currentAssistantId: undefined,
      currentRun: undefined,
      cost: 0,
      lengthLimited: false,
      closed: false,
    };
    thread.unsubscribe = loop.subscribe((event) => this.consume(thread, event));
    this.active = thread;
    this.options.store.showBtw({
      id,
      model: selection.label,
      status: "Starting side agent…",
      busy: true,
      messages: [userMessage(initialQuestion)],
      activeTools: [],
    });
    this.runQuestion(thread, initialQuestion, false);
    return true;
  }

  async close(): Promise<void> {
    const thread = this.active;
    if (thread) await this.closeThread(thread);
  }

  async dispose(): Promise<void> {
    this.removeDecisionHandler();
    const thread = this.active;
    if (thread) await this.closeThread(thread);
  }

  private ask(thread: ActiveThread, question: string): void {
    const state = this.options.store.snapshot.btw;
    if (!state || state.id !== thread.id || state.busy || thread.closed) return;
    this.options.store.updateBtw(thread.id, {
      busy: true,
      status: "Thinking…",
      messages: [...state.messages, userMessage(question)],
      activeTools: [],
    });
    this.runQuestion(thread, question, true);
  }

  private runQuestion(thread: ActiveThread, question: string, includeUpdates: boolean): void {
    const updates = includeUpdates ? this.collectMainUpdates(thread) : "";
    const prompt = buildQuestionPrompt(question, this.options.getLiveStatus(), updates);
    const run = thread.loop.submit(prompt);
    thread.currentRun = run;
    void run
      .catch(() => undefined)
      .finally(() => {
        if (thread.currentRun === run) thread.currentRun = undefined;
      });
  }

  private consume(thread: ActiveThread, event: AgentEvent): void {
    if (thread.closed || this.active !== thread) return;
    const state = this.options.store.snapshot.btw;
    if (!state || state.id !== thread.id) return;

    switch (event.type) {
      case "response_start": {
        thread.lengthLimited = false;
        const message: UiBtwMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          streaming: true,
        };
        thread.currentAssistantId = message.id;
        this.options.store.updateBtw(thread.id, {
          busy: true,
          status: "Thinking…",
          messages: [...state.messages, message],
        });
        break;
      }
      case "text_delta":
        this.updateAssistant(thread, (message) => ({
          ...message,
          content: message.content + event.delta,
          streaming: true,
        }));
        this.options.store.updateBtw(thread.id, { status: "Responding…" });
        break;
      case "assistant_message":
        this.updateAssistant(thread, (message) => ({
          ...message,
          content: event.message.content || message.content || "(No textual response.)",
          streaming: false,
        }));
        break;
      case "response_end":
        thread.lengthLimited = event.stopReason === "length";
        break;
      case "tool_execution_start":
        this.options.store.updateBtw(thread.id, {
          status: "Inspecting…",
          activeTools: [...state.activeTools, event.name],
        });
        break;
      case "tool_execution_end": {
        const activeTools = [...state.activeTools];
        const index = activeTools.indexOf(event.name);
        if (index >= 0) activeTools.splice(index, 1);
        this.options.store.updateBtw(thread.id, {
          status: activeTools.length > 0 ? "Inspecting…" : "Thinking…",
          activeTools,
        });
        break;
      }
      case "usage":
        thread.cost += event.usage.cost ?? 0;
        break;
      case "error":
        this.fail(thread, event.error.message);
        break;
      case "cancelled":
        if (!thread.closed) this.fail(thread, "Side agent cancelled.");
        break;
      case "idle": {
        thread.currentAssistantId = undefined;
        const failed = this.options.store.snapshot.btw?.status === "Side-agent error";
        this.options.store.updateBtw(thread.id, {
          busy: false,
          status: failed
            ? "Side-agent error"
            : thread.lengthLimited
              ? "Ready · response reached its length limit"
              : "Ready for a follow-up",
          activeTools: [],
        });
        break;
      }
      case "user_message":
      case "thinking_delta":
      case "tool_call_start":
      case "tool_call_delta":
      case "tool_call_end":
      case "provider_tool_result":
      case "tool_execution_output":
      case "tool_execution_preview":
      case "tool_result":
        break;
    }
  }

  private updateAssistant(
    thread: ActiveThread,
    update: (message: UiBtwMessage) => UiBtwMessage,
  ): void {
    const state = this.options.store.snapshot.btw;
    const id = thread.currentAssistantId;
    if (!state || state.id !== thread.id || !id) return;
    const messages = state.messages.map((message) =>
      message.id === id ? update(message) : message,
    );
    this.options.store.updateBtw(thread.id, { messages });
  }

  private fail(thread: ActiveThread, error: string): void {
    const state = this.options.store.snapshot.btw;
    if (!state || state.id !== thread.id) return;
    const currentId = thread.currentAssistantId;
    let messages = [...state.messages];
    const current = currentId ? messages.find((message) => message.id === currentId) : undefined;
    if (current && current.content.trim().length === 0) {
      messages = messages.map((message) =>
        message.id === current.id
          ? { ...message, role: "error", content: error, streaming: false }
          : message,
      );
    } else {
      messages.push({ id: crypto.randomUUID(), role: "error", content: error });
    }
    thread.currentAssistantId = undefined;
    this.options.store.updateBtw(thread.id, {
      busy: false,
      status: "Side-agent error",
      messages,
      activeTools: [],
    });
  }

  private collectMainUpdates(thread: ActiveThread): string {
    const messages = this.options.getMainMessages();
    const updates = messages
      .slice(thread.mainMessageCount)
      .map(formatMessage)
      .filter((text): text is string => text !== undefined)
      .join("\n\n");
    thread.mainMessageCount = messages.length;
    return tail(updates, MAX_UPDATE_TEXT);
  }

  private async closeThread(thread: ActiveThread): Promise<void> {
    if (thread.closed) return;
    thread.closed = true;
    if (this.active === thread) this.active = undefined;
    this.options.store.clearBtw(thread.id);
    thread.unsubscribe();
    thread.loop.cancel();
    await thread.currentRun?.catch(() => undefined);
    thread.provider.close?.();
    if (thread.cost > 0) await this.options.onCost?.(thread.cost);
  }
}

function userMessage(question: string): UiBtwMessage {
  return { id: crypto.randomUUID(), role: "user", content: question };
}

function buildQuestionPrompt(question: string, liveStatus: string, updates: string): string {
  return `<btw_live_main_status>
${tail(liveStatus, MAX_LIVE_TEXT)}
${updates ? `\nMain-chat activity completed since the previous side question:\n${updates}` : ""}
</btw_live_main_status>

<side_question>
${question}
</side_question>`;
}

function formatMessage(message: Message): string | undefined {
  if (message.role === "user") {
    if (message.internal) return undefined;
    return `[Main user] ${tail(message.content, MAX_ENTRY_TEXT)}`;
  }
  if (message.role === "assistant") {
    const calls = message.toolCalls.map((call) => call.name);
    const sections = [
      message.content ? tail(message.content, MAX_ENTRY_TEXT) : "",
      calls.length > 0 ? `Tool calls: ${calls.join(", ")}` : "",
    ].filter(Boolean);
    return `[Main assistant] ${sections.join("\n")}`;
  }
  return `[Main tool result: ${message.name}] ${tail(message.content, MAX_ENTRY_TEXT)}`;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[...${text.length - maxChars} earlier characters omitted]\n${text.slice(-maxChars)}`;
}
