import type { OAuthAuthInfo, OAuthPrompt } from "@oh-my-pi/pi-ai";

import { launchBrowser } from "../cli/auth-prompter.ts";
import type { AuthPrompter } from "../providers/auth-service.ts";
import { UiStore, type UiAuthPrompt } from "./state.ts";

interface PendingInput {
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveAuth {
  readonly id: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly onAbort: () => void;
  state: UiAuthPrompt;
  pending: PendingInput | undefined;
}

/** Keeps OAuth prompts inside the mounted Brisk interface. */
export class UiAuthController {
  private readonly removeDecisionHandler: () => void;
  private active: ActiveAuth | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly store: UiStore) {
    this.removeDecisionHandler = store.setAuthDecisionHandler((id, value) => {
      this.resolveFromUi(id, value);
    });
  }

  begin(provider: string, controller: AbortController): AuthPrompter {
    if (this.disposed) throw new Error("Authentication UI is closed");
    if (this.active) throw new Error("An authentication flow is already active");

    const id = `auth-${this.sequence++}`;
    const onAbort = (): void => this.handleAbort(id);
    const state: UiAuthPrompt = {
      id,
      provider,
      input: "",
      inputId: 0,
      allowEmpty: false,
    };
    this.active = { id, provider, controller, onAbort, state, pending: undefined };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    this.store.showAuth(state);

    return {
      openBrowser: (info) => this.openBrowser(id, info),
      prompt: (prompt) => this.requestPrompt(id, prompt),
      manualCode: () =>
        this.requestPrompt(id, {
          message: "Paste the callback URL or authorization code",
          allowEmpty: false,
        }),
      progress: (message) => this.setProgress(id, message),
    };
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.cancelActive(active);
  }

  close(): void {
    const active = this.active;
    if (!active) return;
    this.finish(active, new Error("Authentication UI closed"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDecisionHandler();
    const active = this.active;
    if (active) this.cancelActive(active);
  }

  private openBrowser(id: string, info: OAuthAuthInfo): void {
    const active = this.requireActive(id);
    const opened = launchBrowser(info.url);
    const next: UiAuthPrompt = {
      ...active.state,
      ...(info.instructions === undefined ? {} : { instructions: info.instructions }),
      browserStatus: opened
        ? "Authorization page opened in your browser."
        : `Open this URL: ${info.launchUrl ?? info.url}`,
    };
    active.state = next;
    this.store.showAuth(next);
  }

  private setProgress(id: string, message: string): void {
    const active = this.requireActive(id);
    const next = { ...active.state, progress: message };
    active.state = next;
    this.store.showAuth(next);
  }

  private requestPrompt(id: string, prompt: OAuthPrompt): Promise<string> {
    const active = this.requireActive(id);
    if (active.pending)
      return Promise.reject(new Error("An authentication prompt is already active"));

    return new Promise((resolve, reject) => {
      active.pending = { resolve, reject };
      const next = withoutAuthError({
        ...active.state,
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
        input: "",
        inputId: active.state.inputId + 1,
        allowEmpty: prompt.allowEmpty ?? false,
      });
      active.state = next;
      this.store.showAuth(next);
    });
  }

  private resolveFromUi(id: string, value: string | undefined): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    if (value === undefined) {
      this.cancelActive(active);
      return;
    }

    const answer = value.trim();
    if (!answer && !active.state.allowEmpty) {
      const next = { ...active.state, error: "A value is required." };
      active.state = next;
      this.store.showAuth(next);
      return;
    }

    const pending = active.pending;
    if (!pending) return;
    active.pending = undefined;
    this.store.showAuth(withoutAuthError({ ...active.state, input: "" }));
    pending.resolve(answer);
  }

  private handleAbort(id: string): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    this.cancelActive(active);
  }

  private cancelActive(active: ActiveAuth): void {
    const error = new DOMException("Authentication cancelled", "AbortError");
    const pending = active.pending;
    active.pending = undefined;
    active.controller.signal.removeEventListener("abort", active.onAbort);
    this.active = undefined;
    this.store.clearAuth(active.id);
    pending?.reject(error);
    if (!active.controller.signal.aborted) active.controller.abort(error);
  }

  private finish(active: ActiveAuth, error: Error): void {
    if (this.active !== active) return;
    const pending = active.pending;
    active.pending = undefined;
    active.controller.signal.removeEventListener("abort", active.onAbort);
    this.active = undefined;
    this.store.clearAuth(active.id);
    pending?.reject(error);
  }

  private requireActive(id: string): ActiveAuth {
    const active = this.active;
    if (!active || active.id !== id) throw new Error("Authentication flow is no longer active");
    return active;
  }
}

function withoutAuthError(state: UiAuthPrompt): UiAuthPrompt {
  const { error: _error, ...next } = state;
  return next;
}
