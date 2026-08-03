import {
  SyntaxStyle,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type {
  UiAgentIndicator,
  UiAgentPanelState,
  UiAgentStatus,
  UiApprovalDecision,
  UiApprovalPrompt,
  UiMessage,
  UiPickerPrompt,
  UiStore,
} from "./state.ts";

const COLORS = {
  background: "#0b0d10",
  surface: "#12161c",
  border: "#303846",
  text: "#d8dee9",
  muted: "#768194",
  accent: "#79c0ff",
  user: "#a5d6ff",
  success: "#7ee787",
  warning: "#e3b341",
  error: "#ff7b72",
} as const;

const COMPOSER_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

export interface RootProps {
  store: UiStore;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onAbort: () => void;
  onExit: () => void;
  onOpenModels?: () => void;
  onOpenSessions?: () => void;
}

function MessageBody(props: { message: UiMessage; syntaxStyle: SyntaxStyle }) {
  return (
    <box flexDirection="column" marginBottom={1} width="100%">
      <text fg={props.message.role === "user" ? COLORS.user : COLORS.accent}>
        {props.message.role === "user" ? "you" : props.message.role}
        {props.message.streaming ? "  ◐" : ""}
      </text>
      <Show when={props.message.thinking}>
        {(thinking: () => string) => (
          <box flexDirection="column">
            <text fg={COLORS.muted}>
              thinking · {props.message.thinkingExpanded ? "expanded" : "collapsed"} · Tab toggles
            </text>
            <Show when={props.message.thinkingExpanded}>
              <text fg={COLORS.muted}>{thinking()}</text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={props.message.content.length > 0}>
        <markdown
          content={props.message.content}
          syntaxStyle={props.syntaxStyle}
          streaming={props.message.streaming ?? false}
          conceal
          concealCode={false}
          fg={COLORS.text}
          width="100%"
        />
      </Show>
      <For each={props.message.tools ?? []}>
        {(tool) => (
          <box
            flexDirection="column"
            border={["left"]}
            borderColor={COLORS.border}
            paddingLeft={1}
            marginTop={1}
          >
            <text fg={tool.status === "failed" ? COLORS.error : COLORS.muted}>
              {tool.status === "running" ? "◐" : tool.status === "completed" ? "✓" : "·"}{" "}
              {tool.name}
              {tool.summary ? ` · ${tool.summary}` : ""}
              {tool.output || tool.diff ? ` · ${tool.expanded ? "expanded" : "collapsed"}` : ""}
            </text>
            <Show when={tool.expanded && tool.diff}>
              {(diff: () => string) => (
                <diff
                  diff={diff()}
                  view="unified"
                  wrapMode="char"
                  showLineNumbers
                  height={Math.min(18, Math.max(5, diff().split("\n").length + 1))}
                  width="100%"
                  addedBg="#173b2a"
                  removedBg="#4a2026"
                />
              )}
            </Show>
            <Show when={tool.expanded && tool.output && !tool.diff}>
              {(output: () => string) => <text fg={COLORS.text}>{output()}</text>}
            </Show>
          </box>
        )}
      </For>
      <Show when={props.message.error}>
        <text fg={COLORS.error}>{props.message.error}</text>
      </Show>
    </box>
  );
}

function ApprovalOverlay(props: { approval: UiApprovalPrompt }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width="72%"
        maxWidth={84}
        minWidth={44}
        flexDirection="column"
        border
        borderColor={COLORS.warning}
        backgroundColor={COLORS.surface}
        paddingX={2}
        paddingY={1}
      >
        <text fg={COLORS.warning}>
          <strong>Approval required</strong> · {props.approval.toolName}
        </text>
        <text fg={COLORS.text}>{props.approval.summary}</text>
        <Show when={props.approval.command}>
          {(command: () => string) => <text fg={COLORS.muted}>command · {command()}</text>}
        </Show>
        <Show when={props.approval.targetPaths.length > 0}>
          <text fg={COLORS.muted}>targets · {props.approval.targetPaths.join(", ")}</text>
        </Show>
        <Show when={props.approval.diff}>
          {(diff: () => string) => (
            <diff
              diff={diff()}
              view="unified"
              wrapMode="char"
              showLineNumbers
              height={12}
              width="100%"
              addedBg="#173b2a"
              removedBg="#4a2026"
            />
          )}
        </Show>
        <text fg={COLORS.warning}>risk · {props.approval.riskDescription}</text>
        <text fg={COLORS.text} marginTop={1}>
          [A] approve once · [S] approve equivalent for session · [D/Esc] deny
        </text>
      </box>
    </box>
  );
}

function PickerOverlay(props: { picker: UiPickerPrompt }) {
  const visibleOptions = createMemo(() => {
    const start = Math.max(
      0,
      Math.min(props.picker.selectedIndex - 5, props.picker.options.length - 12),
    );
    return props.picker.options.slice(start, start + 12).map((option, offset) => ({
      option,
      index: start + offset,
    }));
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={90}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width="72%"
        maxWidth={90}
        minWidth={44}
        flexDirection="column"
        border
        borderColor={COLORS.accent}
        backgroundColor={COLORS.surface}
        paddingX={2}
        paddingY={1}
      >
        <text fg={COLORS.accent}>
          <strong>{props.picker.title}</strong>
        </text>
        <For each={visibleOptions()}>
          {(row) => (
            <text
              fg={
                row.option.disabled
                  ? COLORS.muted
                  : row.index === props.picker.selectedIndex
                    ? COLORS.success
                    : COLORS.text
              }
            >
              {row.index === props.picker.selectedIndex ? "› " : "  "}
              {row.option.label}
              {row.option.description ? ` · ${row.option.description}` : ""}
            </text>
          )}
        </For>
        <text fg={COLORS.muted} marginTop={1}>
          ↑/↓ or Ctrl+K/J · Enter select · Esc cancel
        </text>
      </box>
    </box>
  );
}

function agentStatusIcon(status: UiAgentStatus): string {
  switch (status) {
    case "running":
      return "◐";
    case "completed":
      return "✓";
    case "blocked":
      return "!";
    case "failed":
      return "×";
    case "cancelled":
      return "–";
    case "queued":
      return "·";
  }
}

function agentStatusColor(status: UiAgentStatus): string {
  switch (status) {
    case "completed":
      return COLORS.success;
    case "blocked":
    case "queued":
      return COLORS.warning;
    case "failed":
      return COLORS.error;
    case "cancelled":
      return COLORS.muted;
    case "running":
      return COLORS.accent;
  }
}

function AgentPanel(props: { agents: readonly UiAgentIndicator[]; panel: UiAgentPanelState }) {
  const selected = createMemo(() =>
    props.agents.find((agent) => agent.id === props.panel.selectedAgentId),
  );
  const visibleAgents = createMemo(() => {
    const selectedIndex = Math.max(
      0,
      props.agents.findIndex((agent) => agent.id === props.panel.selectedAgentId),
    );
    const start = Math.max(0, Math.min(selectedIndex - 2, props.agents.length - 6));
    return props.agents.slice(start, start + 6).map((agent, offset) => ({
      agent,
      index: start + offset,
    }));
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={80}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width="94%"
        height="100%"
        maxWidth={100}
        maxHeight={20}
        flexDirection="column"
        border
        borderColor={COLORS.accent}
        backgroundColor={COLORS.surface}
        paddingX={2}
        paddingY={1}
      >
        <Show
          when={props.panel.view === "detail" ? selected() : undefined}
          fallback={
            <>
              <text fg={COLORS.accent}>
                <strong>Agents</strong> · {props.agents.length} children
              </text>
              <box flexDirection="column" flexGrow={1} marginTop={1}>
                <For each={visibleAgents()}>
                  {(row) => (
                    <text
                      fg={
                        row.agent.id === props.panel.selectedAgentId
                          ? COLORS.success
                          : agentStatusColor(row.agent.status)
                      }
                    >
                      {row.agent.id === props.panel.selectedAgentId ? "› " : "  "}
                      {agentStatusIcon(row.agent.status)} {row.agent.description} ·{" "}
                      {row.agent.status} · {row.agent.mode} · {row.agent.provider}/{row.agent.model}{" "}
                      · in {row.agent.inputTokens.toLocaleString()} out{" "}
                      {row.agent.outputTokens.toLocaleString()}
                    </text>
                  )}
                </For>
              </box>
              <text fg={COLORS.muted}>↑/↓ or Ctrl+K/J · Enter detail · C cancel · Esc close</text>
            </>
          }
        >
          {(agent: () => UiAgentIndicator) => (
            <>
              <text fg={COLORS.accent}>
                <strong>Agent detail</strong> · {agent().description}
              </text>
              <box flexDirection="column" flexGrow={1} marginTop={1}>
                <text fg={agentStatusColor(agent().status)}>
                  {agentStatusIcon(agent().status)} status · {agent().status}
                </text>
                <text fg={COLORS.text}>mode · {agent().mode}</text>
                <text fg={COLORS.text}>
                  model · {agent().provider}/{agent().model}
                </text>
                <text fg={COLORS.text}>
                  tokens · input {agent().inputTokens.toLocaleString()} · output{" "}
                  {agent().outputTokens.toLocaleString()}
                </text>
                <text fg={COLORS.muted}>session · {agent().childSessionId}</text>
                <text fg={COLORS.muted}>
                  transcript · private continuation ·{" "}
                  {(agent().inputTokens + agent().outputTokens).toLocaleString()} tokens
                </text>
                <For each={(agent().transcript ?? []).slice(-6)}>
                  {(line) => (
                    <text fg={line.role === "assistant" ? COLORS.accent : COLORS.text}>
                      {line.role} · {line.content.replaceAll(/\s+/g, " ").slice(0, 180)}
                    </text>
                  )}
                </For>
                <Show when={agent().summary}>
                  {(summary: () => string) => (
                    <text fg={COLORS.success}>summary · {summary()}</text>
                  )}
                </Show>
                <Show when={agent().error}>
                  {(error: () => string) => <text fg={COLORS.error}>error · {error()}</text>}
                </Show>
              </box>
              <text fg={COLORS.muted}>Esc parent agents · C cancel child</text>
            </>
          )}
        </Show>
      </box>
    </box>
  );
}

function Conversation(props: { messages: readonly UiMessage[] }) {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: COLORS.text },
    keyword: { fg: "#ff7b72", bold: true },
    string: { fg: "#a5d6ff" },
    comment: { fg: COLORS.muted, italic: true },
    function: { fg: "#d2a8ff" },
    type: { fg: "#ffa657" },
    variable: { fg: COLORS.text },
  });
  onCleanup(() => syntaxStyle.destroy());

  return (
    <For each={props.messages}>
      {(message) => <MessageBody message={message} syntaxStyle={syntaxStyle} />}
    </For>
  );
}

export function Root(props: RootProps) {
  const [state, setState] = createSignal(props.store.snapshot);
  const [composerLines, setComposerLines] = createSignal(1);
  const [historyLimit, setHistoryLimit] = createSignal(100);
  let composer: TextareaRenderable | undefined;
  let conversation: ScrollBoxRenderable | undefined;
  let submitting = false;
  let overlayWasVisible =
    state().approval !== undefined ||
    state().picker !== undefined ||
    state().agentPanel !== undefined;

  const unsubscribe = props.store.subscribe(setState);
  onCleanup(unsubscribe);

  createEffect(() => {
    const overlayVisible =
      state().approval !== undefined ||
      state().picker !== undefined ||
      state().agentPanel !== undefined;
    if (overlayVisible) composer?.blur();
    else if (overlayWasVisible) queueMicrotask(() => composer?.focus());
    overlayWasVisible = overlayVisible;
  });

  const visibleMessages = createMemo(() => state().messages.slice(-historyLimit()));
  const hiddenMessageCount = createMemo(() =>
    Math.max(0, state().messages.length - visibleMessages().length),
  );
  const composerHeight = createMemo(() => Math.min(7, Math.max(3, composerLines() + 1)));
  const contextWindowLabel = createMemo(() => {
    const contextWindow = state().contextWindow;
    return contextWindow === undefined ? "" : `/${contextWindow.toLocaleString()}`;
  });

  const submit = (): void => {
    if (!composer || submitting) return;
    const value = composer.plainText.trim();
    if (!value) return;
    submitting = true;
    setTimeout(() => {
      setTimeout(async () => {
        try {
          if (await props.onSubmit(value)) {
            composer?.clear();
            setComposerLines(1);
          }
        } catch {
          // preserve the draft when submission fails
        } finally {
          submitting = false;
          if (
            !props.store.snapshot.approval &&
            !props.store.snapshot.picker &&
            !props.store.snapshot.agentPanel
          )
            composer?.focus();
        }
      }, 0);
    }, 0);
  };

  const decideApproval = (decision: UiApprovalDecision): void => {
    props.store.decideApproval(decision);
  };

  const revealOlderMessages = (): boolean => {
    if (hiddenMessageCount() === 0) return false;
    const previousHeight = conversation?.scrollHeight ?? 0;
    const previousTop = conversation?.scrollTop ?? 0;
    setHistoryLimit((value) => value + 100);
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (!conversation) return;
        conversation.scrollTop =
          previousTop + Math.max(0, conversation.scrollHeight - previousHeight);
      });
    });
    return true;
  };

  useKeyboard((key) => {
    if (state().approval) {
      key.preventDefault();
      key.stopPropagation();
      if (key.ctrl || key.meta) return;
      if (key.name === "a") decideApproval("approve_once");
      else if (key.name === "s") decideApproval("approve_session");
      else if (key.name === "d" || key.name === "escape") decideApproval("deny");
      return;
    }
    if (state().picker) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "up" || (key.ctrl && key.name === "k")) props.store.movePicker(-1);
      else if (key.name === "down" || (key.ctrl && key.name === "j")) props.store.movePicker(1);
      else if (key.name === "return") props.store.decidePicker(true);
      else if (key.name === "escape") props.store.decidePicker(false);
      return;
    }
    if (state().agentPanel) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "up" || (key.ctrl && key.name === "k")) {
        props.store.moveAgentSelection(-1);
      } else if (key.name === "down" || (key.ctrl && key.name === "j")) {
        props.store.moveAgentSelection(1);
      } else if (key.name === "return") {
        props.store.openSelectedAgent();
      } else if (key.name === "c") {
        props.store.cancelSelectedAgent();
      } else if (key.name === "escape") {
        props.store.backAgentPanel();
      }
      return;
    }
    if (key.name === "pageup" && revealOlderMessages()) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "tab" && props.store.toggleLatestDisclosure()) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "escape" && state().busy) {
      key.preventDefault();
      key.stopPropagation();
      props.onAbort();
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      if (state().busy) props.onAbort();
      else props.onExit();
      return;
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault();
      key.stopPropagation();
      props.onOpenModels?.();
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      key.stopPropagation();
      props.onOpenSessions?.();
    }
  });

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.background}>
      <box height={1} flexShrink={0} paddingX={1} backgroundColor={COLORS.surface} width="100%">
        <text fg={COLORS.text}>
          <strong>Brisk</strong> · {state().workspace} · {state().providerModel}
        </text>
      </box>

      <scrollbox
        id="conversation-scroll"
        ref={(node) => {
          conversation = node;
        }}
        flexGrow={1}
        width="100%"
        paddingX={2}
        paddingTop={1}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
      >
        <Show
          when={visibleMessages().length > 0}
          fallback={
            <text fg={COLORS.muted}>Ask Brisk to inspect, explain, or change this workspace.</text>
          }
        >
          <Show when={hiddenMessageCount() > 0}>
            <text fg={COLORS.muted}>
              ··· {hiddenMessageCount().toLocaleString()} older messages · PageUp loads more
            </text>
          </Show>
          <Conversation messages={visibleMessages()} />
        </Show>
      </scrollbox>

      <Show when={state().agents.length > 0}>
        <box height={1} paddingX={1} flexShrink={0}>
          <text fg={COLORS.muted}>
            /agents · agents ·{" "}
            {state()
              .agents.map(
                (agent) =>
                  `${agentStatusIcon(agent.status)} ${agent.description} [${agent.status} · ${agent.mode} · ${agent.provider}/${agent.model} · ${agent.inputTokens.toLocaleString()}/${agent.outputTokens.toLocaleString()}]`,
              )
              .join("  ")}
          </text>
        </box>
      </Show>

      <box height={1} flexShrink={0} paddingX={1} backgroundColor={COLORS.surface} width="100%">
        <text fg={COLORS.muted}>
          context {state().contextTokens.toLocaleString()}
          {contextWindowLabel()} · cost ${state().cost.toFixed(4)} · {state().status} ·{" "}
          {state().mode}
        </text>
      </box>

      <box
        height={composerHeight()}
        minHeight={3}
        maxHeight={7}
        flexShrink={0}
        border={["top"]}
        borderColor={COLORS.border}
        paddingX={1}
        paddingY={0}
        width="100%"
        backgroundColor={COLORS.background}
      >
        <text fg={state().busy ? COLORS.warning : COLORS.success} width={2}>
          {state().busy ? "◐" : ">"}
        </text>
        <textarea
          ref={(node) => {
            composer = node;
            queueMicrotask(() => {
              if (
                !props.store.snapshot.approval &&
                !props.store.snapshot.picker &&
                !props.store.snapshot.agentPanel
              )
                node.focus();
            });
          }}
          focused
          flexGrow={1}
          height="100%"
          keyBindings={COMPOSER_BINDINGS}
          placeholder="Send a message or /help · Ctrl+J for newline"
          placeholderColor={COLORS.muted}
          textColor={COLORS.text}
          backgroundColor={COLORS.background}
          focusedBackgroundColor={COLORS.background}
          focusedTextColor={COLORS.text}
          wrapMode="word"
          onContentChange={() => {
            if (composer) setComposerLines(composer.lineCount);
          }}
          onSubmit={submit}
        />
      </box>

      <Show
        when={state().approval}
        fallback={
          <Show
            when={state().picker}
            fallback={
              <Show when={state().agentPanel}>
                {(panel: () => UiAgentPanelState) => (
                  <AgentPanel agents={state().agents} panel={panel()} />
                )}
              </Show>
            }
          >
            {(picker: () => UiPickerPrompt) => <PickerOverlay picker={picker()} />}
          </Show>
        }
      >
        {(approval: () => UiApprovalPrompt) => <ApprovalOverlay approval={approval()} />}
      </Show>
    </box>
  );
}
