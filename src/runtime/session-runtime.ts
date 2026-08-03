import type { AgentLoop } from "../core/agent-loop.ts";
import type { Message, Usage } from "../core/messages.ts";
import { AgentSessionRecorder } from "../sessions/agent-recorder.ts";
import { SessionRepository } from "../sessions/repository.ts";
import {
  canonicalWorkspace,
  type ChildSessionReference,
  type CompactionMetadata,
  type InterruptedAssistantDiagnostic,
  type LoadedSession,
  type SessionIndexRecord,
  type SessionMetadata,
} from "../sessions/types.ts";

export interface SessionRuntimeOptions {
  readonly sessionsDir: string;
  readonly sessionIndexPath: string;
  readonly artifactsDir: string;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly continueLast?: boolean;
  readonly selectedProvider?: string;
  readonly selectedModel?: string;
}

/** Owns one append-only parent session while allowing fast indexed switches. */
export class SessionRuntime {
  readonly repository: SessionRepository;
  private currentValue: LoadedSession;
  private recorder: AgentSessionRecorder | undefined;
  private closed = false;

  private constructor(
    private readonly options: SessionRuntimeOptions,
    repository: SessionRepository,
    loaded: LoadedSession,
  ) {
    this.repository = repository;
    this.currentValue = loaded;
  }

  static async initialize(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    const repository = new SessionRepository({
      sessionsDir: options.sessionsDir,
      sessionIndexPath: options.sessionIndexPath,
    });
    try {
      let loaded: LoadedSession | undefined;
      if (options.sessionId) loaded = await repository.open(options.sessionId);
      else if (options.continueLast) loaded = await repository.continueLatest(options.workspace);
      if (!loaded) {
        const created = await repository.create({
          title: defaultTitle(),
          workspace: options.workspace,
          selectedProvider: options.selectedProvider ?? "unselected",
          selectedModel: options.selectedModel ?? "unselected",
        });
        loaded = await repository.open(created.metadata.id);
      }
      assertWorkspace(loaded.metadata, options.workspace);
      return new SessionRuntime(options, repository, loaded);
    } catch (error) {
      await repository.close().catch(() => undefined);
      throw error;
    }
  }

  get current(): LoadedSession {
    return this.currentValue;
  }

  get metadata(): SessionMetadata {
    return this.currentValue.metadata;
  }

  get sessionId(): string {
    return this.currentValue.metadata.id;
  }

  get messages(): readonly Message[] {
    return this.currentValue.messages;
  }

  get usage(): Usage {
    const usage = this.currentValue.metadata.usageTotals;
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
      cost: usage.cost,
    };
  }

  get interrupted(): InterruptedAssistantDiagnostic | undefined {
    return this.currentValue.partialAssistant;
  }

  get artifactDirectory(): string {
    return `${this.options.artifactsDir}/${this.sessionId}`;
  }

  get previousCompaction(): CompactionMetadata | undefined {
    for (let index = this.currentValue.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.currentValue.entries[index];
      if (entry?.type === "compaction") return entry.compaction;
    }
    return undefined;
  }

  get selectedModelSpecifier(): string | undefined {
    const { selectedProvider, selectedModel } = this.metadata;
    return selectedProvider === "unselected" || selectedModel === "unselected"
      ? undefined
      : `${selectedProvider}/${selectedModel}`;
  }

  attach(loop: AgentLoop, onError?: (error: Error) => void): void {
    if (this.closed) throw new Error("Session runtime is closed");
    if (this.recorder) throw new Error("Session recorder is already attached");
    const recorder = new AgentSessionRecorder({
      repository: this.repository,
      sessionId: this.sessionId,
      ...(onError === undefined ? {} : { onError }),
    });
    recorder.attach(loop);
    this.recorder = recorder;
  }

  async recordChild(child: ChildSessionReference): Promise<void> {
    await this.repository.append(this.sessionId, { type: "child_session", child });
    this.currentValue = await this.repository.open(this.sessionId);
  }

  async recordCompaction(compaction: CompactionMetadata): Promise<void> {
    if (this.recorder) {
      this.recorder.append({ type: "compaction", compaction });
      await this.recorder.flush();
    } else {
      await this.repository.append(this.sessionId, { type: "compaction", compaction });
    }
    this.currentValue = await this.repository.open(this.sessionId);
  }

  async recordModelChange(provider: string, model: string): Promise<void> {
    if (this.recorder) {
      this.recorder.append({ type: "model_change", provider, model });
      await this.recorder.flush();
    } else {
      await this.repository.append(this.sessionId, { type: "model_change", provider, model });
    }
    this.currentValue = await this.repository.open(this.sessionId);
  }

  async createNew(provider = "unselected", model = "unselected"): Promise<LoadedSession> {
    await this.detachRecorder();
    const created = await this.repository.create({
      title: defaultTitle(),
      workspace: this.options.workspace,
      selectedProvider: provider,
      selectedModel: model,
    });
    this.currentValue = await this.repository.open(created.metadata.id);
    return this.currentValue;
  }

  async open(id: string): Promise<LoadedSession> {
    await this.detachRecorder();
    const loaded = await this.repository.open(id);
    assertWorkspace(loaded.metadata, this.options.workspace);
    this.currentValue = loaded;
    return loaded;
  }

  async listWorkspace(): Promise<readonly SessionIndexRecord[]> {
    return await this.repository.list({ workspace: this.options.workspace });
  }

  async detach(): Promise<void> {
    await this.detachRecorder();
    this.currentValue = await this.repository.open(this.sessionId);
  }

  async flush(): Promise<void> {
    await this.recorder?.flush();
    await this.repository.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.detachRecorder();
    await this.repository.close();
  }

  private async detachRecorder(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = undefined;
    await recorder?.dispose();
  }
}

function assertWorkspace(metadata: SessionMetadata, workspace: string): void {
  const expected = canonicalWorkspace(workspace);
  if (metadata.workspace !== expected) {
    throw new Error(
      `Session ${metadata.id} belongs to ${metadata.workspace}, not the current workspace ${expected}`,
    );
  }
}

function defaultTitle(now = new Date()): string {
  return `Brisk session ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}
