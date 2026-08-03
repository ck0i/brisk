import { afterEach, describe, expect, test } from "bun:test";
import { computeFileHash } from "@oh-my-pi/hashline";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
} from "../../src/tools/approval.ts";
import { registerCodingTools } from "../../src/tools/coding-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

class RecordingApprovalHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly decision: ApprovalDecision = "approve_once") {}

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return Promise.resolve(this.decision);
  }
}

describe("native coding tool agent flow", () => {
  test("reads Hashline anchors, previews and applies an edit, streams bash, and follows up", async () => {
    const workspace = await makeWorkspace();
    const source = "export const value = 1;\n";
    await writeFile(join(workspace, "src", "value.ts"), source);
    const approval = new RecordingApprovalHandler();
    const tools = new ToolRegistry();
    await registerCodingTools(tools, {
      workspace,
      artifactsDirectory: join(workspace, ".artifacts"),
      permissionMode: "safe",
      approvalHandler: approval,
      knownSecretValues: [],
    });
    const tag = computeFileHash(source);
    const provider = new FakeProvider([
      {
        toolCalls: [{ id: "read-1", name: "read", arguments: { path: "src/value.ts" } }],
      },
      {
        toolCalls: [
          {
            id: "edit-1",
            name: "edit",
            arguments: {
              patch: `[src/value.ts#${tag}]\nPUT 1.=1:\n+export const value = 2;`,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "bash-1",
            name: "bash",
            arguments: {
              command: "printf 'test passed\\n' && grep -q 'value = 2' src/value.ts",
            },
          },
        ],
      },
      { text: ["Updated the value", " and verified it."] },
    ]);
    const loop = new AgentLoop({ provider, tools, model: "fake/coding" });
    const streamed: string[] = [];
    loop.subscribe((event) => {
      if (event.type === "tool_execution_output") streamed.push(event.delta);
    });

    await loop.submit("Update the value and verify it");

    expect(await readFile(join(workspace, "src", "value.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(tools.schemas.map((schema) => schema.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "list",
      "read",
      "search",
      "write",
    ]);
    expect(approval.requests.map((request) => request.toolName)).toEqual(["edit", "bash"]);
    expect(approval.requests[0]?.diff).toContain("-export const value = 1;");
    expect(approval.requests[0]?.diff).toContain("+export const value = 2;");
    expect(streamed.join("")).toContain("test passed");
    expect(loop.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Updated the value and verified it.",
    });
    const readResult = loop.messages.find(
      (message) => message.role === "tool" && message.name === "read",
    );
    expect(readResult?.content).toContain(`[src/value.ts#${tag}]`);
  });

  test("denial discards a prepared mutation without touching the workspace", async () => {
    const workspace = await makeWorkspace();
    const path = join(workspace, "existing.txt");
    await writeFile(path, "old\n");
    const tools = new ToolRegistry();
    await registerCodingTools(tools, {
      workspace,
      artifactsDirectory: join(workspace, ".artifacts"),
      permissionMode: "safe",
      approvalHandler: new RecordingApprovalHandler("deny"),
      knownSecretValues: [],
    });

    const [result] = await tools.execute(
      [
        {
          id: "write-denied",
          name: "write",
          arguments: JSON.stringify({ path: "existing.txt", content: "new\n", mode: "replace" }),
        },
      ],
      new AbortController().signal,
    );

    expect(result).toMatchObject({ isError: true, content: "Write denied by user or policy." });
    expect(await readFile(path, "utf8")).toBe("old\n");
  });
});

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "brisk-coding-tools-"));
  temporaryDirectories.push(workspace);
  await mkdir(join(workspace, "src"), { recursive: true });
  return workspace;
}
