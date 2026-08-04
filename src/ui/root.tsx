import {
  SyntaxStyle,
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { redactSecrets } from "../providers/secret-redaction.ts";
import { BUILT_IN_SLASH_COMMANDS, type SlashCommand } from "./slash-commands.ts";
import type {
  UiAgentIndicator,
  UiAgentPanelState,
  UiAgentStatus,
  UiApprovalDecision,
  UiApprovalPrompt,
  UiAuthPrompt,
  UiExtensionSlot,
  UiMessage,
  UiPickerPrompt,
  UiStore,
  UiTextInputPrompt,
  UiTheme,
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

const HIGH_CONTRAST_COLORS = {
  ...COLORS,
  background: "#000000",
  surface: "#000000",
  border: "#ffffff",
  text: "#ffffff",
  muted: "#d7d7d7",
  accent: "#00ffff",
  user: "#ffff00",
  success: "#00ff00",
  warning: "#ffff00",
  error: "#ff5f5f",
} as const;

export function paletteForTheme(theme: UiTheme) {
  return theme === "high-contrast" ? HIGH_CONTRAST_COLORS : COLORS;
}

const COMPOSER_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

function normalizedExtensionKey(key: {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly option: boolean;
}): string {
  return [
    ...(key.ctrl ? ["ctrl"] : []),
    ...(key.meta ? ["meta"] : []),
    ...(key.option ? ["alt"] : []),
    ...(key.shift ? ["shift"] : []),
    key.name.toLowerCase(),
  ].join("+");
}

export interface RootProps {
  store: UiStore;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onAbort: () => void;
  onExit: () => void;
  onOpenModels?: () => void;
  onOpenSessions?: () => void;
  onKeybinding?: (key: string) => void;
}

function disclosedText(value: string, expanded: boolean | undefined, limit = 240): string {
  return expanded || value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function compactLine(value: string, limit = 72): string {
  const normalized = singleLine(value);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function messageRoleLabel(role: UiMessage["role"]): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Agent";
    case "system":
      return "System";
  }
}

function MessageBody(props: {
  message: UiMessage;
  syntaxStyle: SyntaxStyle;
  showThinking: boolean;
}) {
  return (
    <box flexDirection="column" marginBottom={1} width="100%">
      <text fg={props.message.role === "user" ? COLORS.user : COLORS.accent}>
        {messageRoleLabel(props.message.role)}
        {props.message.streaming ? "  ◐" : ""}
      </text>
      <Show when={props.message.thinking}>
        {(thinking: () => string) => (
          <box flexDirection="column">
            <text fg={COLORS.muted}>
              thinking ·{" "}
              {(props.message.thinkingExpanded ?? props.showThinking) ? "expanded" : "collapsed"} ·
              Tab toggles
            </text>
            <Show when={props.message.thinkingExpanded ?? props.showThinking}>
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
        {(error: () => string) => (
          <text fg={COLORS.error}>
            {disclosedText(error(), props.message.errorExpanded)}
            {error().length > 240
              ? ` · ${props.message.errorExpanded ? "expanded" : "collapsed"} · Tab toggles`
              : ""}
          </text>
        )}
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

function SlashMenu(props: {
  options: readonly { readonly command: SlashCommand; readonly index: number }[];
  selectedIndex: number;
}) {
  return (
    <box
      minHeight={1}
      maxHeight={12}
      flexShrink={0}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      backgroundColor={COLORS.surface}
    >
      <For each={props.options}>
        {(row) => (
          <text fg={row.index === props.selectedIndex ? COLORS.success : COLORS.text}>
            {row.index === props.selectedIndex ? "› " : "  "}
            {row.command.name} · {row.command.description}
          </text>
        )}
      </For>
      <text fg={COLORS.muted}>↑/↓ choose · Enter insert · Esc close</text>
    </box>
  );
}

function TextInputOverlay(props: { prompt: UiTextInputPrompt; store: UiStore }) {
  let input: InputRenderable | undefined;

  createEffect(() => {
    const value = props.prompt.value;
    queueMicrotask(() => {
      if (!input) return;
      input.value = value;
      input.focus();
    });
  });

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
        width="68%"
        maxWidth={80}
        minWidth={42}
        flexDirection="column"
        border
        borderColor={COLORS.accent}
        backgroundColor={COLORS.surface}
        paddingX={2}
        paddingY={1}
      >
        <text fg={COLORS.accent}>
          <strong>{props.prompt.title}</strong>
        </text>
        <text fg={COLORS.text}>{props.prompt.message}</text>
        <box flexDirection="row" marginTop={1} height={1}>
          <text fg={COLORS.success} width={2}>
            ›
          </text>
          <input
            ref={(node) => {
              input = node;
              queueMicrotask(() => {
                node.value = props.prompt.value;
                node.focus();
              });
            }}
            focused
            flexGrow={1}
            placeholder={props.prompt.placeholder ?? ""}
            placeholderColor={COLORS.muted}
            textColor={COLORS.text}
            backgroundColor={COLORS.surface}
            focusedBackgroundColor={COLORS.surface}
            focusedTextColor={COLORS.text}
            onSubmit={() => props.store.decideTextInput(input?.value ?? "")}
          />
        </box>
        <Show when={props.prompt.error}>
          {(error: () => string) => <text fg={COLORS.error}>{error()}</text>}
        </Show>
        <text fg={COLORS.muted} marginTop={1}>
          Enter save · Esc cancel
        </text>
      </box>
    </box>
  );
}

function AuthOverlay(props: { auth: UiAuthPrompt; store: UiStore }) {
  let input: InputRenderable | undefined;
  let inputId = -1;

  createEffect(() => {
    const nextInputId = props.auth.inputId;
    if (nextInputId === inputId) return;
    inputId = nextInputId;
    queueMicrotask(() => {
      if (!input) return;
      input.value = "";
      input.focus();
    });
  });

  const submit = (): void => {
    props.store.decideAuth(input?.value ?? "");
  };

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
        width="78%"
        maxWidth={94}
        minWidth={48}
        flexDirection="column"
        border
        borderColor={COLORS.accent}
        backgroundColor={COLORS.surface}
        paddingX={2}
        paddingY={1}
      >
        <text fg={COLORS.accent}>
          <strong>Sign in</strong> · {props.auth.provider}
        </text>
        <Show when={props.auth.instructions}>
          {(instructions: () => string) => <text fg={COLORS.text}>{instructions()}</text>}
        </Show>
        <Show when={props.auth.browserStatus}>
          {(status: () => string) => <text fg={COLORS.success}>{status()}</text>}
        </Show>
        <Show when={props.auth.progress}>
          {(progress: () => string) => <text fg={COLORS.muted}>{progress()}</text>}
        </Show>
        <Show when={props.auth.message}>
          {(message: () => string) => (
            <>
              <text fg={COLORS.text}>{message()}</text>
              <box flexDirection="row" marginTop={1} height={1}>
                <text fg={COLORS.success} width={2}>
                  ›
                </text>
                <input
                  ref={(node) => {
                    input = node;
                    queueMicrotask(() => node.focus());
                  }}
                  focused
                  flexGrow={1}
                  placeholder={props.auth.placeholder ?? ""}
                  placeholderColor={COLORS.muted}
                  textColor={COLORS.text}
                  backgroundColor={COLORS.surface}
                  focusedBackgroundColor={COLORS.surface}
                  focusedTextColor={COLORS.text}
                  onSubmit={submit}
                />
              </box>
            </>
          )}
        </Show>
        <Show when={props.auth.error}>
          {(error: () => string) => <text fg={COLORS.error}>{error()}</text>}
        </Show>
        <text fg={COLORS.muted} marginTop={1}>
          {props.auth.message ? "Enter submit · Esc cancel" : "Esc cancel"}
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

function agentStripSummary(agents: readonly UiAgentIndicator[]): string {
  const order: readonly UiAgentStatus[] = [
    "running",
    "queued",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ];
  return order
    .map((status) => ({
      status,
      count: agents.filter((agent) => agent.status === status).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${agentStatusIcon(entry.status)} ${entry.count} ${entry.status}`)
    .join(" · ");
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
    const start = Math.max(0, Math.min(selectedIndex - 1, props.agents.length - 4));
    return props.agents.slice(start, start + 4).map((agent, offset) => ({
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
              <text fg={COLORS.accent} height={1} wrapMode="none" truncate>
                <strong>Agents</strong> · {props.agents.length} children
              </text>
              <box flexDirection="column" flexGrow={1} marginTop={1}>
                <For each={visibleAgents()}>
                  {(row) => (
                    <box height={2} flexShrink={0} flexDirection="column" width="100%">
                      <text
                        height={1}
                        wrapMode="none"
                        truncate
                        fg={
                          row.agent.id === props.panel.selectedAgentId
                            ? COLORS.success
                            : agentStatusColor(row.agent.status)
                        }
                      >
                        {row.agent.id === props.panel.selectedAgentId ? "› " : "  "}
                        {agentStatusIcon(row.agent.status)} {compactLine(row.agent.description)}
                      </text>
                      <text height={1} wrapMode="none" truncate fg={COLORS.muted}>
                        {"    "}
                        {row.agent.status} · {row.agent.mode} · {row.agent.provider}/
                        {row.agent.model} · in {row.agent.inputTokens.toLocaleString()} out{" "}
                        {row.agent.outputTokens.toLocaleString()}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <text fg={COLORS.muted} height={1} wrapMode="none" truncate>
                ↑/↓ or Ctrl+K/J · Enter detail · C cancel · Esc close
              </text>
            </>
          }
        >
          {(agent: () => UiAgentIndicator) => (
            <>
              <text fg={COLORS.accent} height={1} wrapMode="none" truncate>
                <strong>Agent detail</strong> · {singleLine(agent().description)}
              </text>
              <box flexDirection="column" flexGrow={1} marginTop={1}>
                <text fg={agentStatusColor(agent().status)} height={1} wrapMode="none" truncate>
                  {agentStatusIcon(agent().status)} status · {agent().status}
                </text>
                <text fg={COLORS.text} height={1} wrapMode="none" truncate>
                  mode · {agent().mode}
                </text>
                <text fg={COLORS.text} height={1} wrapMode="none" truncate>
                  model · {agent().provider}/{agent().model}
                </text>
                <text fg={COLORS.text} height={1} wrapMode="none" truncate>
                  tokens · input {agent().inputTokens.toLocaleString()} · output{" "}
                  {agent().outputTokens.toLocaleString()}
                </text>
                <text fg={COLORS.muted} height={1} wrapMode="none" truncate>
                  session · {agent().childSessionId}
                </text>
                <text fg={COLORS.muted} height={1} wrapMode="none" truncate>
                  transcript · private continuation ·{" "}
                  {(agent().inputTokens + agent().outputTokens).toLocaleString()} tokens
                </text>
                <For each={(agent().transcript ?? []).slice(-6)}>
                  {(line) => (
                    <text
                      fg={line.role === "assistant" ? COLORS.accent : COLORS.text}
                      height={1}
                      wrapMode="none"
                      truncate
                    >
                      {line.role} · {singleLine(line.content)}
                    </text>
                  )}
                </For>
                <Show when={agent().summary}>
                  {(summary: () => string) => (
                    <text fg={COLORS.success} height={1} wrapMode="none" truncate>
                      summary · {singleLine(summary())}
                    </text>
                  )}
                </Show>
                <Show when={agent().error}>
                  {(error: () => string) => (
                    <text fg={COLORS.error} height={1} wrapMode="none" truncate>
                      error · {singleLine(error())}
                    </text>
                  )}
                </Show>
              </box>
              <text fg={COLORS.muted} height={1} wrapMode="none" truncate>
                Esc parent agents · C cancel child
              </text>
            </>
          )}
        </Show>
      </box>
    </box>
  );
}

function Conversation(props: { messages: readonly UiMessage[]; showThinking: boolean }) {
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
      {(message) => (
        <MessageBody
          message={message}
          syntaxStyle={syntaxStyle}
          showThinking={props.showThinking}
        />
      )}
    </For>
  );
}

export function Root(props: RootProps) {
  const [state, setState] = createSignal(props.store.snapshot);
  const [composerLines, setComposerLines] = createSignal(1);
  const [composerText, setComposerText] = createSignal("");
  const [slashSelectedIndex, setSlashSelectedIndex] = createSignal(0);
  const [slashDismissed, setSlashDismissed] = createSignal(false);
  const [historyLimit, setHistoryLimit] = createSignal(100);
  let composer: TextareaRenderable | undefined;
  let conversation: ScrollBoxRenderable | undefined;
  let suppressSlashDismissalReset = false;
  let latestSubmissionId = 0;
  let overlayWasVisible =
    state().approval !== undefined ||
    state().picker !== undefined ||
    state().textInput !== undefined ||
    state().auth !== undefined ||
    state().agentPanel !== undefined;

  const unsubscribe = props.store.subscribe(setState);
  onCleanup(unsubscribe);

  createEffect(() => {
    const overlayVisible =
      state().approval !== undefined ||
      state().picker !== undefined ||
      state().textInput !== undefined ||
      state().auth !== undefined ||
      state().agentPanel !== undefined;
    if (overlayVisible) composer?.blur();
    else if (overlayWasVisible) queueMicrotask(() => composer?.focus());
    overlayWasVisible = overlayVisible;
  });

  const palette = createMemo(() => paletteForTheme(state().theme));
  const visibleMessages = createMemo(() => state().messages.slice(-historyLimit()));
  const hiddenMessageCount = createMemo(() =>
    Math.max(0, state().messages.length - visibleMessages().length),
  );
  const composerHeight = createMemo(() => Math.min(7, Math.max(2, composerLines() + 1)));
  const slashOptions = createMemo(() => {
    const value = composerText();
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
    const query = value.toLowerCase();
    return BUILT_IN_SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
  });
  const visibleSlashOptions = createMemo(() => {
    const options = slashOptions();
    const selected = slashSelectedIndex();
    const start = Math.max(0, Math.min(selected - 4, options.length - 8));
    return options.slice(start, start + 8).map((command, offset) => ({
      command,
      index: start + offset,
    }));
  });
  const contextWindowLabel = createMemo(() => {
    const contextWindow = state().contextWindow;
    return contextWindow === undefined ? "" : `/${contextWindow.toLocaleString()}`;
  });
  const extensionText = (slot: UiExtensionSlot): string =>
    state()
      .extensionUi.filter((contribution) => contribution.slot === slot)
      .map((contribution) => contribution.text)
      .join(" · ");

  createEffect(() => {
    slashOptions();
    setSlashSelectedIndex(0);
  });

  const selectSlashCommand = (command: SlashCommand): void => {
    if (!composer) return;
    suppressSlashDismissalReset = true;
    composer.setText(command.name);
    composer.cursorOffset = command.name.length;
    setComposerText(command.name);
    setSlashDismissed(true);
    composer.focus();
  };

  const restoreSubmittedDraft = (value: string, submissionId: number): void => {
    if (!composer || submissionId !== latestSubmissionId || composer.plainText.length > 0) return;
    composer.setText(value);
    composer.cursorOffset = value.length;
    setComposerLines(composer.lineCount);
    setComposerText(value);
  };

  const focusComposerWithoutOverlay = (): void => {
    if (
      !props.store.snapshot.approval &&
      !props.store.snapshot.picker &&
      !props.store.snapshot.textInput &&
      !props.store.snapshot.auth &&
      !props.store.snapshot.agentPanel
    )
      composer?.focus();
  };

  const submit = (): void => {
    if (!composer) return;
    const draft = composer.plainText;
    const value = draft.trim();
    if (!value) return;
    const submissionId = ++latestSubmissionId;
    setSlashDismissed(true);
    props.store.clearNotice();
    composer.clear();
    setComposerLines(1);
    setComposerText("");

    let result: boolean | Promise<boolean>;
    try {
      result = props.onSubmit(value);
    } catch (error) {
      restoreSubmittedDraft(draft, submissionId);
      const message = error instanceof Error ? error.message : String(error);
      props.store.update({ status: "error", notice: redactSecrets(message) });
      focusComposerWithoutOverlay();
      return;
    }

    void Promise.resolve(result)
      .then((accepted) => {
        if (!accepted) restoreSubmittedDraft(draft, submissionId);
      })
      .catch((error: unknown) => {
        restoreSubmittedDraft(draft, submissionId);
        const message = error instanceof Error ? error.message : String(error);
        props.store.update({ status: "error", notice: redactSecrets(message) });
      })
      .finally(focusComposerWithoutOverlay);
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
    if (state().textInput) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        key.preventDefault();
        key.stopPropagation();
        props.store.decideTextInput(undefined);
      }
      return;
    }
    if (state().auth) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        key.preventDefault();
        key.stopPropagation();
        props.store.decideAuth(undefined);
      }
      return;
    }
    if (!slashDismissed() && slashOptions().length > 0) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        const delta = key.name === "up" ? -1 : 1;
        const count = slashOptions().length;
        setSlashSelectedIndex((index) => (index + delta + count) % count);
        return;
      }
      if (key.name === "return" && !key.shift && !key.ctrl && !key.meta && !key.option) {
        const command = slashOptions()[slashSelectedIndex()];
        if (command) {
          key.preventDefault();
          key.stopPropagation();
          if (composerText() === command.name) submit();
          else selectSlashCommand(command);
          return;
        }
      }
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }
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
      return;
    }
    const extensionKey = normalizedExtensionKey(key);
    if (state().extensionKeybindings.includes(extensionKey)) {
      key.preventDefault();
      key.stopPropagation();
      props.onKeybinding?.(extensionKey);
    }
  });

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={palette().background}>
      <box height={1} flexShrink={0} paddingX={1} backgroundColor={palette().surface} width="100%">
        <text fg={palette().text}>
          <strong>Brisk</strong> · {state().workspace} · {state().providerModel}
          <Show when={extensionText("header")}> · {extensionText("header")}</Show>
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
            <text fg={palette().muted}>
              Ask Brisk to inspect, explain, or change this workspace.
            </text>
          }
        >
          <Show when={hiddenMessageCount() > 0}>
            <text fg={palette().muted}>
              ··· {hiddenMessageCount().toLocaleString()} older messages · PageUp loads more
            </text>
          </Show>
          <Conversation messages={visibleMessages()} showThinking={state().showThinking} />
        </Show>
      </scrollbox>

      <Show when={extensionText("sidebar")}>
        <box minHeight={1} maxHeight={3} paddingX={1} flexShrink={0}>
          <text fg={palette().muted}>{extensionText("sidebar")}</text>
        </box>
      </Show>

      <Show when={state().agents.length > 0}>
        <box height={1} paddingX={1} flexShrink={0}>
          <text fg={palette().muted} height={1} wrapMode="none" truncate>
            /agents · {state().agents.length} children · {agentStripSummary(state().agents)}
          </text>
        </box>
      </Show>

      <Show when={state().notice}>
        {(notice: () => string) => (
          <box
            minHeight={1}
            maxHeight={state().noticeExpanded ? 12 : 3}
            flexShrink={0}
            paddingX={1}
            width="100%"
          >
            <text fg={palette().error}>
              error
              {notice().length > 240
                ? ` · ${state().noticeExpanded ? "expanded" : "collapsed"} · Tab toggles`
                : ""}
              {" · "}
              {disclosedText(notice(), state().noticeExpanded)}
            </text>
          </box>
        )}
      </Show>

      <box height={1} flexShrink={0} paddingX={1} backgroundColor={palette().surface} width="100%">
        <text fg={palette().muted}>
          context {state().contextTokens.toLocaleString()}
          {contextWindowLabel()} · cache R{state().cacheReadTokens.toLocaleString()} W
          {state().cacheWriteTokens.toLocaleString()} · cost ${state().cost.toFixed(4)} ·{" "}
          {state().status} · {state().mode}
          <Show when={extensionText("status")}> · {extensionText("status")}</Show>
        </text>
      </box>

      <Show when={extensionText("composer")}>
        <box minHeight={1} maxHeight={2} paddingX={2} flexShrink={0}>
          <text fg={palette().muted}>{extensionText("composer")}</text>
        </box>
      </Show>

      <Show
        when={!state().auth && !state().textInput && !slashDismissed() && slashOptions().length > 0}
      >
        <SlashMenu options={visibleSlashOptions()} selectedIndex={slashSelectedIndex()} />
      </Show>

      <box
        height={composerHeight()}
        minHeight={2}
        maxHeight={7}
        flexShrink={0}
        flexDirection="row"
        border={["top"]}
        borderColor={palette().border}
        alignItems="flex-start"
        paddingX={1}
        paddingY={0}
        width="100%"
        backgroundColor={palette().background}
      >
        <text fg={state().busy ? palette().warning : palette().success} width={2}>
          {state().busy ? "◐" : ">"}
        </text>
        <textarea
          ref={(node) => {
            composer = node;
            queueMicrotask(() => {
              if (
                !props.store.snapshot.approval &&
                !props.store.snapshot.picker &&
                !props.store.snapshot.textInput &&
                !props.store.snapshot.auth &&
                !props.store.snapshot.agentPanel
              )
                node.focus();
            });
          }}
          focused
          flexGrow={1}
          height={composerLines()}
          keyBindings={COMPOSER_BINDINGS}
          placeholder="Send a message or /help · Ctrl+J for newline"
          placeholderColor={palette().muted}
          textColor={palette().text}
          backgroundColor={palette().background}
          focusedBackgroundColor={palette().background}
          focusedTextColor={palette().text}
          wrapMode="word"
          onContentChange={() => {
            if (composer) {
              setComposerLines(composer.lineCount);
              setComposerText(composer.plainText);
              if (suppressSlashDismissalReset) suppressSlashDismissalReset = false;
              else setSlashDismissed(false);
            }
          }}
          onSubmit={submit}
        />
      </box>

      <Show when={state().textInput}>
        {(prompt: () => UiTextInputPrompt) => (
          <TextInputOverlay prompt={prompt()} store={props.store} />
        )}
      </Show>

      <Show when={state().auth}>
        {(auth: () => UiAuthPrompt) => <AuthOverlay auth={auth()} store={props.store} />}
      </Show>

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
