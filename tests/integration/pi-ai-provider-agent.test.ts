import { expect, test } from "bun:test";

import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { PiAiProvider } from "../../src/providers/pi-ai-provider.ts";

test("AgentLoop retains upstream identity when PiAiProvider changes models between turns", async () => {
  const first = makeModel("first-provider", "first-model");
  const second = makeModel("second-provider", "second-model");
  const contexts: Context[] = [];
  const provider = new PiAiProvider({
    model: first,
    auth: {
      async getApiKey() {
        return "BRISK_TEST_INTEGRATION_KEY";
      },
    },
    preconnect: () => undefined,
    stream: (model, context) => {
      contexts.push(context);
      return completion(model, model.id);
    },
  });
  const loop = new AgentLoop({ provider, model: "first-provider/first-model" });

  await loop.submit("first turn");
  provider.setModel(second);
  await loop.submit("second turn");

  expect(loop.messages[1]).toMatchObject({
    role: "assistant",
    content: "first-model",
    provider: "first-provider",
    api: "openai-completions",
    model: "first-model",
  });
  const replayed = contexts[1]?.messages[1];
  expect(replayed).toMatchObject({
    role: "assistant",
    provider: "first-provider",
    model: "first-model",
  });
});

function completion(model: Model, text: string): AsyncIterable<AssistantMessageEvent> {
  const start = message(model, []);
  const done = message(model, [{ type: "text", text }]);
  return (async function* () {
    yield { type: "start", partial: start } satisfies AssistantMessageEvent;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: done,
    } satisfies AssistantMessageEvent;
    yield { type: "done", reason: "stop", message: done } satisfies AssistantMessageEvent;
  })();
}

function message(model: Model, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeModel(provider: string, id: string): Model<"openai-completions"> {
  return buildModel({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });
}
