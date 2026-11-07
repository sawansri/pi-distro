/**
 * pi-deep-research search provider: Exa's free MCP endpoint.
 *
 * Needs no API key or account, so web search works right after install.
 * Results come back as text blocks of "Title:", "URL:", "Published:" and
 * "Highlights:" lines, parsed here into search results.
 *
 * Installed by pi-distro into ~/.pi/agent/pi-deep-research/providers/.
 */

// Self-contained: plugins are loaded from a directory without @types/node.
const ENDPOINT = "https://mcp.exa.ai/mcp";

interface Result {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

/** Splits the endpoint's text into one result per "Title:" block. */
export function parseResults(text: string): Result[] {
  return text
    .split(/\n(?=Title: )/)
    .map((block) => {
      const field = (name: string) => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
      const highlights = block.split(/^Highlights:\s*$/m)[1] ?? block.split(/^Text:\s*$/m)[1] ?? "";
      const published = field("Published");
      return {
        title: field("Title"),
        url: field("URL"),
        snippet: highlights.trim().slice(0, 1500),
        publishedDate: published && published !== "N/A" ? published : undefined,
      };
    })
    .filter((r) => r.url);
}

/** The JSON-RPC result from a plain JSON or a server-sent-events response. */
function rpcResult(body: string): { content?: { type: string; text?: string }[]; isError?: boolean } {
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .pop() ?? "{}";
  const message = JSON.parse(json);
  if (message.error) throw new Error(`Exa MCP error: ${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result ?? {};
}

export default {
  name: "exa-mcp",
  tier: "cloud" as const,
  isConfigured: () => true,
  async search(req: { query: string; maxResults: number; signal?: AbortSignal }) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query: req.query, numResults: Math.min(req.maxResults, 10) } },
      }),
      signal: req.signal ?? AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Exa MCP search error ${response.status}: ${await response.text()}`);
    const result = rpcResult(await response.text());
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    if (result.isError) throw new Error(`Exa MCP search failed: ${text.slice(0, 300)}`);
    return parseResults(text).slice(0, req.maxResults);
  },
};
