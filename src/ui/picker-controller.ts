import type { UiPickerOption } from "./state.ts";
import { UiStore } from "./state.ts";

export interface PickerRequest {
  readonly title: string;
  readonly options: readonly UiPickerOption[];
  readonly selectedId?: string;
}

interface PendingPicker {
  readonly id: string;
  readonly request: PickerRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (optionId: string | undefined) => void;
  readonly onAbort: () => void;
}

/** Serializes keyboard-first selectors into the shared TUI overlay slot. */
export class UiPickerController {
  private readonly pending: PendingPicker[] = [];
  private readonly removeHandler: () => void;
  private active: PendingPicker | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly store: UiStore) {
    this.removeHandler = store.setPickerDecisionHandler((id, optionId) => {
      this.resolveFromUi(id, optionId);
    });
  }

  choose(request: PickerRequest, signal?: AbortSignal): Promise<string | undefined> {
    if (this.disposed || signal?.aborted || request.options.length === 0) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const id = `picker-${this.sequence++}`;
      const item: PendingPicker = {
        id,
        request,
        signal,
        resolve,
        onAbort: () => this.abort(id),
      };
      this.pending.push(item);
      signal?.addEventListener("abort", item.onAbort, { once: true });
      if (signal?.aborted) this.abort(id);
      else this.publishNext();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeHandler();
    const unresolved = [...(this.active ? [this.active] : []), ...this.pending];
    this.active = undefined;
    this.pending.length = 0;
    this.store.clearPicker();
    for (const item of unresolved) this.settle(item, undefined);
  }

  private publishNext(): void {
    if (this.disposed || this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    if (item.signal?.aborted) {
      this.settle(item, undefined);
      this.publishNext();
      return;
    }
    const preferred = item.request.selectedId
      ? item.request.options.findIndex((option) => option.id === item.request.selectedId)
      : -1;
    const selectedIndex = firstEnabledIndex(item.request.options, preferred);
    if (selectedIndex === -1) {
      this.settle(item, undefined);
      this.publishNext();
      return;
    }
    this.active = item;
    this.store.showPicker({
      id: item.id,
      title: item.request.title,
      options: item.request.options.map((option) => ({ ...option })),
      selectedIndex,
    });
  }

  private resolveFromUi(id: string, optionId: string | undefined): void {
    const item = this.active;
    if (!item || item.id !== id) return;
    this.active = undefined;
    this.store.clearPicker(id);
    this.settle(item, optionId);
    this.publishNext();
  }

  private abort(id: string): void {
    if (this.active?.id === id) {
      const item = this.active;
      this.active = undefined;
      this.store.clearPicker(id);
      this.settle(item, undefined);
      this.publishNext();
      return;
    }
    const index = this.pending.findIndex((item) => item.id === id);
    if (index === -1) return;
    const [item] = this.pending.splice(index, 1);
    if (item) this.settle(item, undefined);
  }

  private settle(item: PendingPicker, optionId: string | undefined): void {
    item.signal?.removeEventListener("abort", item.onAbort);
    item.resolve(optionId);
  }
}

function firstEnabledIndex(options: readonly UiPickerOption[], preferred: number): number {
  if (preferred >= 0 && !options[preferred]?.disabled) return preferred;
  return options.findIndex((option) => !option.disabled);
}
