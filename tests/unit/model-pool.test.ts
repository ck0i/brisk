import { describe, expect, test } from "bun:test";

import type { Api, Model } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import { NormalizedProviderError, type ProviderEvent } from "../../src/core/events.ts";
import type { Message } from "../../src/core/messages.ts";
import { ModelPool, PooledTransport, modelPoolKey } from "../../src/providers/model-pool.ts";
import type { ModelTransport } from "../../src/providers/transport.ts";
import type { ProviderRequest } from "../../src/providers/types.ts";

type Step = "ok" | "rate_limit" | "fail_after_output";

const text: Message[] = [{ role: "user", content: "hi" }];

describe("model pool", () => {
  test("matches OpenCode Go and Command Code ids by their bare lowercase name only", () => {
    expect(modelPoolKey("opencode-go", "kimi-k2.7-code")).toBe("kimi-k2.7-code");
    expect(modelPoolKey("commandcode", "moonshotai/Kimi-K2.7-Code")).toBe("kimi-k2.7-code");
    expect(modelPoolKey("commandcode", "meituan/LongCat-2.0:free")).not.toBe(
      modelPoolKey("opencode-go", "longcat-2.0"),
    );
    expect(modelPoolKey("anthropic", "claude-sonnet-5")).toBeUndefined();
  });

  test("hides a limited plan behind a transparent failover and sticks to the plan that answered", async () => {
    const go = new FakeMember("opencode-go", ["rate_limit"]);
    const cc = new FakeMember("commandcode", ["ok", "ok"]);
    const transport = pooled(go, cc);

    const first = await collect(transport, text);
    await collect(transport, text);

    expect(first).toEqual([
      { type: "response_start", provider: "commandcode" },
      { type: "text_delta", delta: "from commandcode" },
      { type: "response_end", stopReason: "stop" },
    ]);
    expect(go.calls).toBe(1);
    expect(cc.calls).toBe(2);
  });

  test("passes an error after output through and moves the next request to the other plan", async () => {
    const go = new FakeMember("opencode-go", ["fail_after_output"]);
    const cc = new FakeMember("commandcode", ["ok"]);
    const transport = pooled(go, cc);

    const first = await collect(transport, text);
    const second = await collect(transport, text);

    expect(first).toContainEqual({ type: "text_delta", delta: "from opencode-go" });
    expect(first.at(-1)).toMatchObject({ type: "error", error: { kind: "network" } });
    expect(second).toContainEqual({ type: "text_delta", delta: "from commandcode" });
  });

  test("never fails over onto a plan that cannot see the conversation's images", async () => {
    const go = new FakeMember("opencode-go", ["rate_limit"], ["text", "image"]);
    const cc = new FakeMember("commandcode", ["ok"]);
    const transport = pooled(go, cc);

    const events = await collect(transport, [
      {
        role: "user",
        content: "look",
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    ]);

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "rate_limit" } });
    expect(cc.calls).toBe(0);
  });

  test("spreads subagents across plans even when each one opens a pooled advisor", async () => {
    const pool = new ModelPool(0);
    const children: string[] = [];
    for (let index = 0; index < 4; index++) {
      const child = pooledIn(
        pool,
        new FakeMember("opencode-go", []),
        new FakeMember("commandcode", []),
      );
      pooledIn(pool, new FakeMember("opencode-go", []), new FakeMember("commandcode", []));
      const events = await collect(child, text);
      const answer = events.find((event) => event.type === "text_delta");
      children.push(answer?.type === "text_delta" ? answer.delta : "none");
    }

    expect(children).toEqual([
      "from opencode-go",
      "from commandcode",
      "from opencode-go",
      "from commandcode",
    ]);
  });

  test("moves a conversation off a plan that cannot run the chosen effort", async () => {
    const go = new FakeMember("opencode-go", []);
    const cc = new FakeMember("commandcode", []);
    const transport = new PooledTransport({
      members: [go, cc],
      pool: new ModelPool(1),
      memberReasoning: (model, reasoning) => (model.provider === "commandcode" ? "off" : reasoning),
    });

    await collect(transport, text);
    transport.setReasoning("max" as Effort);
    await collect(transport, text);

    expect(cc.calls).toBe(1);
    expect(go.calls).toBe(1);
  });
});

function pooled(...members: FakeMember[]): PooledTransport {
  return pooledIn(new ModelPool(0), ...members);
}

function pooledIn(pool: ModelPool, ...members: FakeMember[]): PooledTransport {
  return new PooledTransport({
    members,
    pool,
    memberReasoning: (_model, reasoning) => reasoning,
  });
}

async function collect(transport: ModelTransport, messages: Message[]): Promise<ProviderEvent[]> {
  const request: ProviderRequest = {
    systemPrompt: [],
    messages,
    tools: [],
    signal: new AbortController().signal,
    model: "pooled",
  };
  const events: ProviderEvent[] = [];
  for await (const event of transport.stream(request)) events.push(event);
  return events;
}

class FakeMember implements ModelTransport {
  readonly model: Model<Api>;
  calls = 0;

  constructor(
    private readonly provider: string,
    private readonly steps: Step[],
    input: ("text" | "image")[] = ["text"],
  ) {
    this.model = buildModel({
      id: "kimi-k2.7-code",
      name: "Kimi",
      api: "openai-completions",
      provider,
      baseUrl: `https://${provider}.invalid/v1`,
      reasoning: false,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 65_536,
    });
  }

  setModel(): void {}
  setReasoning(): void {}
  setSessionId(): void {}
  close(): void {}

  async *stream(): AsyncIterable<ProviderEvent> {
    const step = this.steps[this.calls++] ?? "ok";
    yield { type: "response_start", provider: this.provider };
    if (step === "rate_limit") {
      yield {
        type: "error",
        error: new NormalizedProviderError("limited", { kind: "rate_limit" }),
      };
      return;
    }
    yield { type: "text_delta", delta: `from ${this.provider}` };
    if (step === "fail_after_output") {
      yield { type: "error", error: new NormalizedProviderError("dropped", { kind: "network" }) };
      return;
    }
    yield { type: "response_end", stopReason: "stop" };
  }
}
