import { describe, expect, test } from "bun:test";

import type { JsonValue, ToolCall } from "../../src/core/messages.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

interface DelayArguments {
  readonly label: string;
  readonly delayMs: number;
}

const delaySchema = {
  type: "object" as const,
  properties: {
    label: { type: "string" as const },
    delayMs: { type: "number" as const },
  },
  required: ["label", "delayMs"],
  additionalProperties: false,
};

describe("ToolRegistry", () => {
  test("runs adjacent parallel-safe reads concurrently and preserves call order", async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maximumActive = 0;

    registry.register<DelayArguments>({
      name: "read",
      description: "A deterministic read",
      inputSchema: delaySchema,
      readOnly: true,
      parallelSafe: true,
      parse: parseDelayArguments,
      async execute(arguments_, context) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await sleep(arguments_.delayMs, context.signal);
        active -= 1;
        return { content: arguments_.label };
      },
    });

    const calls: ToolCall[] = [
      { id: "slow", name: "read", arguments: '{"label":"first","delayMs":20}' },
      { id: "fast", name: "read", arguments: '{"label":"second","delayMs":3}' },
    ];
    const results = await registry.execute(calls, new AbortController().signal);

    expect(maximumActive).toBe(2);
    expect(results.map((result) => result.toolCallId)).toEqual(["slow", "fast"]);
    expect(results.map((result) => result.content)).toEqual(["first", "second"]);
    expect(registry.schemas).toEqual([
      { name: "read", description: "A deterministic read", inputSchema: delaySchema },
    ]);
  });

  test("uses mutating tools as serialization barriers", async () => {
    const registry = new ToolRegistry();
    const trace: string[] = [];

    registry.register<DelayArguments>({
      name: "read",
      description: "read",
      inputSchema: delaySchema,
      readOnly: true,
      parallelSafe: true,
      parse: parseDelayArguments,
      async execute(arguments_) {
        trace.push(`start:${arguments_.label}`);
        await Bun.sleep(arguments_.delayMs);
        trace.push(`end:${arguments_.label}`);
        return { content: arguments_.label };
      },
    });
    registry.register<DelayArguments>({
      name: "write",
      description: "write",
      inputSchema: delaySchema,
      parse: parseDelayArguments,
      async execute(arguments_) {
        trace.push(`start:${arguments_.label}`);
        await Bun.sleep(arguments_.delayMs);
        trace.push(`end:${arguments_.label}`);
        return { content: arguments_.label };
      },
    });

    await registry.execute(
      [
        { id: "1", name: "read", arguments: '{"label":"r1","delayMs":8}' },
        { id: "2", name: "read", arguments: '{"label":"r2","delayMs":2}' },
        { id: "3", name: "write", arguments: '{"label":"w","delayMs":1}' },
        { id: "4", name: "read", arguments: '{"label":"r3","delayMs":1}' },
      ],
      new AbortController().signal,
    );

    expect(trace.indexOf("start:w")).toBeGreaterThan(trace.indexOf("end:r1"));
    expect(trace.indexOf("start:w")).toBeGreaterThan(trace.indexOf("end:r2"));
    expect(trace.indexOf("start:r3")).toBeGreaterThan(trace.indexOf("end:w"));
  });

  test("streams lifecycle and output events without changing ordered results", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.register<DelayArguments>({
      name: "stream",
      description: "stream output",
      inputSchema: delaySchema,
      parse: parseDelayArguments,
      execute(arguments_, context) {
        context.emitOutput("stdout", "first");
        context.emitOutput("stderr", "second");
        return { content: arguments_.label };
      },
    });
    const [result] = await registry.execute(
      [{ id: "stream-1", name: "stream", arguments: '{"label":"done","delayMs":0}' }],
      new AbortController().signal,
      {
        onStart: (call) => events.push(`start:${call.id}`),
        onOutput: (_call, stream, delta) => events.push(`${stream}:${delta}`),
        onEnd: (call, completed) => events.push(`end:${call.id}:${completed.content}`),
      },
    );

    expect(result?.content).toBe("done");
    expect(events).toEqual([
      "start:stream-1",
      "stdout:first",
      "stderr:second",
      "end:stream-1:done",
    ]);
  });

  test("returns useful invalid argument, unknown tool, and timeout results", async () => {
    const registry = new ToolRegistry(10);
    let executions = 0;
    registry.register<DelayArguments>({
      name: "slow",
      description: "slow",
      inputSchema: delaySchema,
      parse: parseDelayArguments,
      execute(_arguments, context) {
        executions += 1;
        return new Promise((resolve) => {
          context.signal.addEventListener("abort", () => resolve({ content: "late completion" }), {
            once: true,
          });
        });
      },
    });

    const results = await registry.execute(
      [
        { id: "bad-json", name: "slow", arguments: "{" },
        { id: "bad-shape", name: "slow", arguments: '{"label":"x"}' },
        { id: "missing", name: "absent", arguments: "{}" },
        { id: "timeout", name: "slow", arguments: '{"label":"x","delayMs":0}' },
      ],
      new AbortController().signal,
    );

    expect(executions).toBe(1);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(results[0]?.content).toContain("Invalid arguments for slow");
    expect(results[1]?.content).toContain("$arguments.delayMs is required");
    expect(results[2]?.content).toBe("Unknown tool: absent");
    expect(results[3]?.content).toContain("timed out after 10ms");
  });
});

function parseDelayArguments(value: JsonValue): DelayArguments {
  if (!isJsonObject(value)) throw new TypeError("arguments must be an object");
  const label = value.label;
  const delayMs = value.delayMs;
  if (typeof label !== "string" || typeof delayMs !== "number") {
    throw new TypeError("label and delayMs are required");
  }
  return { label, delayMs };
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
