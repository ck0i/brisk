import { SyntaxStyle, type KeyBinding, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";

import type { UiMessage, UiStore } from "./state.ts";

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

function MessageBody(props: { message: UiMessage }) {
  const style = SyntaxStyle.fromStyles({
    default: { fg: COLORS.text },
    keyword: { fg: "#ff7b72", bold: true },
    string: { fg: "#a5d6ff" },
    comment: { fg: COLORS.muted, italic: true },
    function: { fg: "#d2a8ff" },
    type: { fg: "#ffa657" },
    variable: { fg: COLORS.text },
  });
  onCleanup(() => style.destroy());

  return (
    <box flexDirection="column" marginBottom={1} width="100%">
      <text fg={props.message.role === "user" ? COLORS.user : COLORS.accent}>
        {props.message.role === "user" ? "you" : props.message.role}
        {props.message.streaming ? "  ◐" : ""}
      </text>
      <Show when={props.message.thinking}>
        <text fg={COLORS.muted}>thinking · collapsed</text>
      </Show>
      <Show when={props.message.content.length > 0}>
        <markdown
          content={props.message.content}
          syntaxStyle={style}
          streaming={props.message.streaming ?? false}
          conceal
          concealCode={false}
          fg={COLORS.text}
          width="100%"
        />
      </Show>
      <For each={props.message.tools ?? []}>
        {(tool) => (
          <box border={["left"]} borderColor={COLORS.border} paddingLeft={1} marginTop={1}>
            <text fg={tool.status === "failed" ? COLORS.error : COLORS.muted}>
              {tool.status === "running" ? "◐" : tool.status === "completed" ? "✓" : "·"}{" "}
              {tool.name}
              {tool.summary ? ` · ${tool.summary}` : ""}
            </text>
          </box>
        )}
      </For>
      <Show when={props.message.error}>
        <text fg={COLORS.error}>{props.message.error}</text>
      </Show>
    </box>
  );
}

export function Root(props: RootProps) {
  const [state, setState] = createSignal(props.store.snapshot);
  const [composerLines, setComposerLines] = createSignal(1);
  let composer: TextareaRenderable | undefined;
  let submitting = false;

  const unsubscribe = props.store.subscribe(setState);
  onCleanup(unsubscribe);

  const visibleMessages = createMemo(() => state().messages.slice(-100));
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
        } finally {
          submitting = false;
          composer?.focus();
        }
      }, 0);
    }, 0);
  };

  useKeyboard((key) => {
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
          <For each={visibleMessages()}>{(message) => <MessageBody message={message} />}</For>
        </Show>
      </scrollbox>

      <Show when={state().agents.length > 0}>
        <box height={1} paddingX={1} flexShrink={0}>
          <text fg={COLORS.muted}>
            agents ·{" "}
            {state()
              .agents.map(
                (agent) => `${agent.status === "running" ? "◐" : "✓"} ${agent.description}`,
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
            queueMicrotask(() => node.focus());
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
    </box>
  );
}
