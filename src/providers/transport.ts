import type { Api, Model } from "@oh-my-pi/pi-catalog";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import type { Provider } from "./types.ts";

/** Shared model-backed transport used by the main session and isolated children. */
export interface ModelTransport extends Provider {
  readonly model: Model<Api>;
  setModel(model: Model<Api>): void;
  setReasoning(reasoning: Effort | "off" | undefined): void;
  setSessionId(sessionId: string | undefined): void;
  close(): void;
}

export function isCursorAgentModel(model: Model<Api>): boolean {
  return model.api === "cursor-agent";
}
