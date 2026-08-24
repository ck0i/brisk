import { describe, expect, test } from "bun:test";

import { searchWeb, type WebSearchOptions } from "../../src/tools/web-search.ts";

const signal = new AbortController().signal;

describe("web search", () => {
  test("calls Exa's MCP search tool and returns its source-grounded text", async () => {
    let request: Readonly<Record<string, unknown>> | undefined;
    const fetcher: NonNullable<WebSearchOptions["fetcher"]> = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: "Title: Brisk Docs\nURL: https://example.com/brisk\nHighlights:\nCurrent details",
            },
          ],
        },
      });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const output = await searchWeb(
      { query: "  current Brisk documentation  ", numResults: 3 },
      { endpoint: "https://search.test/mcp", fetcher, signal },
    );

    expect(request).toMatchObject({
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: "current Brisk documentation", numResults: 3 },
      },
    });
    expect(output).toContain('Web search results for "current Brisk documentation"');
    expect(output).toContain("https://example.com/brisk");
    expect(output).toContain("Current details");
  });

  test("reports bounded provider failures", async () => {
    const fetcher: NonNullable<WebSearchOptions["fetcher"]> = async () =>
      new Response(`rate limited ${"x".repeat(1_000)}`, { status: 429 });

    await expect(
      searchWeb(
        { query: "latest release" },
        { endpoint: "https://search.test/mcp", fetcher, signal },
      ),
    ).rejects.toThrow(/HTTP 429: rate limited x+\.\.\.$/);
  });
});
