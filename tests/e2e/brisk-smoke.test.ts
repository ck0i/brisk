import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPackageBundle } from "../../scripts/build-package.ts";
import type { ProviderEvent } from "../../src/core/events.ts";
import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { ToolResultMessage } from "../../src/core/messages.ts";
import { FakeProvider, type FakeProviderTurn } from "../../src/providers/fake-provider.ts";
import type { Provider, ProviderRequest } from "../../src/providers/types.ts";
import { SessionRuntime } from "../../src/runtime/session-runtime.ts";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
} from "../../src/tools/approval.ts";
import { registerCodingTools } from "../../src/tools/coding-tools.ts";
import { cleanupToolProcesses, toolProcessRegistry } from "../../src/tools/process-registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceBefore = "export const value = 1;\n";
const sourceAfter = "export const value = 2;\n";
const finalChunks = ["Updated the value", " and verified", " it with the test suite."] as const;

class ApprovingHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return Promise.resolve("approve_once");
  }
}

/**
 * Uses the real fake provider emitter, but derives the edit from the read result
 * delivered through the live agent history instead of precomputing a file tag.
 */
class DynamicFakeProvider implements Provider {
  readonly requests: ProviderRequest[] = [];
  readOutput: string | undefined;
  editPatch: string | undefined;
  private turnIndex = 0;

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({ ...request, messages: [...request.messages], tools: [...request.tools] });
    const turn = this.nextTurn(request);
    const emitter = new FakeProvider([turn]);
    yield* emitter.stream(request);
  }

  private nextTurn(request: ProviderRequest): FakeProviderTurn {
    const turn = this.turnIndex;
    this.turnIndex += 1;
    switch (turn) {
      case 0:
        requireLastMessage(request, "user", "Update the exported value to 2 and run its test");
        requireTools(request, ["bash", "edit", "find", "list", "read", "search", "write"]);
        return {
          id: "read-response",
          toolCalls: [{ id: "read-1", name: "read", arguments: { path: "src/value.ts" } }],
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        };
      case 1: {
        const result = requireToolResult(request, "read-1", "read");
        const lines = result.content.split("\n");
        const header = lines[0];
        if (!header || !/^\[src\/value\.ts#[0-9A-F]{4}\]$/.test(header)) {
          throw new Error(`Read did not return a Hashline header: ${result.content}`);
        }
        if (lines.slice(1).join("\n") !== "1:export const value = 1;\n2:") {
          throw new Error(`Read did not return the exact numbered source: ${result.content}`);
        }
        this.readOutput = result.content;
        this.editPatch = `${header}\nPUT 1.=1:\n+export const value = 2;`;
        return {
          id: "edit-response",
          toolCalls: [
            {
              id: "edit-1",
              name: "edit",
              arguments: { patch: this.editPatch },
            },
          ],
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      }
      case 2: {
        const result = requireToolResult(request, "edit-1", "edit");
        if (result.isError || !result.content.includes("Edit committed atomically")) {
          throw new Error(`Edit did not commit: ${result.content}`);
        }
        return {
          id: "bash-response",
          toolCalls: [
            {
              id: "bash-1",
              name: "bash",
              arguments: { command: "bun test value.test.ts" },
            },
          ],
          usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
        };
      }
      case 3: {
        const result = requireToolResult(request, "bash-1", "bash");
        if (result.isError || !result.content.includes("[exit=0")) {
          throw new Error(`Test command did not pass: ${result.content}`);
        }
        return {
          id: "final-response",
          text: finalChunks,
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        };
      }
      default:
        throw new Error(`Unexpected provider turn ${turn}`);
    }
  }
}

test("Brisk edits, verifies, persists, closes, and resumes a coding session", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "brisk-e2e-"));
  const workspace = join(fixtureRoot, "workspace");
  const sessionsDir = join(fixtureRoot, "state", "sessions");
  const sessionIndexPath = join(fixtureRoot, "state", "session-index.json");
  const artifactsDir = join(fixtureRoot, "state", "artifacts");
  let runtime: SessionRuntime | undefined;
  let resumed: SessionRuntime | undefined;

  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "value.ts"), sourceBefore);
    await writeFile(
      join(workspace, "value.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { value } from "./src/value.ts";',
        "",
        'test("value is updated", () => expect(value).toBe(2));',
        "",
      ].join("\n"),
    );

    runtime = await SessionRuntime.initialize({
      sessionsDir,
      sessionIndexPath,
      artifactsDir,
      workspace,
      selectedProvider: "fake",
      selectedModel: "coding-smoke",
    });
    const sessionId = runtime.sessionId;
    const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
    const initialTranscript = await readFile(transcriptPath, "utf8");
    const approvals = new ApprovingHandler();
    const tools = new ToolRegistry();
    await registerCodingTools(tools, {
      workspace,
      artifactsDirectory: runtime.artifactDirectory,
      permissionMode: "safe",
      approvalHandler: approvals,
      knownSecretValues: [],
    });
    const provider = new DynamicFakeProvider();
    const loop = new AgentLoop({ provider, tools, model: "fake/coding-smoke" });
    const textDeltas: string[] = [];
    const bashDeltas: string[] = [];
    loop.subscribe((event) => {
      if (event.type === "text_delta") textDeltas.push(event.delta);
      if (event.type === "tool_execution_output" && event.name === "bash") {
        bashDeltas.push(event.delta);
      }
    });
    runtime.attach(loop);

    await loop.submit("Update the exported value to 2 and run its test");
    await runtime.flush();

    expect(await readFile(join(workspace, "src", "value.ts"), "utf8")).toBe(sourceAfter);
    expect(provider.readOutput).toMatch(/^\[src\/value\.ts#[0-9A-F]{4}\]\n/);
    expect(provider.editPatch?.split("\n")[0]).toBe(provider.readOutput?.split("\n")[0]);
    expect(provider.requests).toHaveLength(4);
    expect(textDeltas).toEqual([...finalChunks]);
    expect(bashDeltas.join("")).toContain("value is updated");
    expect(loop.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: finalChunks.join(""),
    });
    expect(loop.usage).toEqual({ inputTokens: 22, outputTokens: 7, totalTokens: 29 });
    expect(approvals.requests.map((request) => request.toolName)).toEqual(["edit", "bash"]);
    expect(approvals.requests[0]?.diff).toContain("+export const value = 2;");
    expect(approvals.requests[1]?.command).toBe("bun test value.test.ts");
    expect(toolProcessRegistry.size).toBe(0);

    const persistedTranscript = await readFile(transcriptPath, "utf8");
    expect(persistedTranscript.startsWith(initialTranscript)).toBe(true);
    const entries = persistedTranscript
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly type: string;
            readonly sequence: number;
            readonly message?: ToolResultMessage;
          },
      );
    expect(entries.map((entry) => entry.sequence)).toEqual(entries.map((_, index) => index + 1));
    expect(
      entries.filter((entry) => entry.type === "tool_result").map((entry) => entry.message?.name),
    ).toEqual(["read", "edit", "bash"]);
    expect(entries.filter((entry) => entry.type === "assistant_text")).toHaveLength(
      finalChunks.length,
    );

    const expectedMessages = [...loop.messages];
    await runtime.close();
    expect(await readFile(transcriptPath, "utf8")).toBe(persistedTranscript);

    resumed = await SessionRuntime.initialize({
      sessionsDir,
      sessionIndexPath,
      artifactsDir,
      workspace,
      continueLast: true,
    });
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.selectedModelSpecifier).toBe("fake/coding-smoke");
    expect(resumed.messages).toEqual(expectedMessages);
    expect(resumed.usage).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 29,
      cost: 0,
    });
  } finally {
    await resumed?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await cleanupToolProcesses();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("packaged CLI loads the Solid transform outside the repository", async () => {
  const outsideDirectory = await mkdtemp(join(tmpdir(), "brisk-outside-cwd-"));
  const bundleDirectory = await mkdtemp(
    join(repositoryRoot, "node_modules", ".brisk-package-test-"),
  );
  const executable = await buildPackageBundle(bundleDirectory);
  const child = Bun.spawn([executable, "bench", "--json"], {
    cwd: outsideDirectory,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      schemaVersion?: number;
      metrics?: Array<{
        name?: string;
        statistics?: { median?: number };
      }>;
    };
    expect(result.schemaVersion).toBe(1);
    expect(
      result.metrics?.find((metric) => metric.name === "opentui.first_draw")?.statistics?.median,
    ).toBeNumber();
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
    await Promise.all([
      rm(outsideDirectory, { recursive: true, force: true }),
      rm(bundleDirectory, { recursive: true, force: true }),
    ]);
  }
});

function requireToolResult(
  request: ProviderRequest,
  callId: string,
  name: string,
): ToolResultMessage {
  const message = request.messages.at(-1);
  if (message?.role !== "tool" || message.toolCallId !== callId || message.name !== name) {
    throw new Error(`Expected ${name} result ${callId}`);
  }
  return message;
}

function requireLastMessage(request: ProviderRequest, role: "user", content: string): void {
  const message = request.messages.at(-1);
  if (message?.role !== role || message.content !== content) {
    throw new Error(`Expected ${role} message ${JSON.stringify(content)}`);
  }
}

function requireTools(request: ProviderRequest, expected: readonly string[]): void {
  const actual = request.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${actual.join(", ")}`);
  }
}
