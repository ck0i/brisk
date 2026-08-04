import { UiStore, type UiTextInputPrompt } from "./state.ts";

export interface TextInputRequest {
  readonly title: string;
  readonly message: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | undefined;
}

interface ActiveTextInput {
  readonly id: string;
  readonly request: TextInputRequest;
  readonly resolve: (value: string | undefined) => void;
  state: UiTextInputPrompt;
}

/** Owns one keyboard text prompt inside the mounted TUI. */
export class UiTextInputController {
  private readonly removeDecisionHandler: () => void;
  private active: ActiveTextInput | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly store: UiStore) {
    this.removeDecisionHandler = store.setTextInputDecisionHandler((id, value) => {
      this.resolveFromUi(id, value);
    });
  }

  prompt(request: TextInputRequest): Promise<string | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.active) throw new Error("A text input prompt is already active");
    return new Promise((resolve) => {
      const id = `text-input-${this.sequence++}`;
      const state: UiTextInputPrompt = {
        id,
        title: request.title,
        message: request.message,
        value: request.value ?? "",
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      };
      this.active = { id, request, resolve, state };
      this.store.showTextInput(state);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDecisionHandler();
    const active = this.active;
    this.active = undefined;
    this.store.clearTextInput();
    active?.resolve(undefined);
  }

  private resolveFromUi(id: string, value: string | undefined): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    if (value === undefined) {
      this.finish(active, undefined);
      return;
    }

    const answer = value.trim();
    const error = active.request.validate?.(answer);
    if (error) {
      active.state = { ...active.state, value: answer, error };
      this.store.showTextInput(active.state);
      return;
    }
    this.finish(active, answer);
  }

  private finish(active: ActiveTextInput, value: string | undefined): void {
    if (this.active !== active) return;
    this.active = undefined;
    this.store.clearTextInput(active.id);
    active.resolve(value);
  }
}
