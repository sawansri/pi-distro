import assert from "node:assert/strict";
import { test } from "node:test";
import provider, { parseResults } from "../providers/exa-mcp.ts";

test("parses title, url, date and highlights", () => {
  const text = [
    "Title: First\nURL: https://a.example/1\nPublished: 2026-10-01\nAuthor: N/A\nHighlights:\nAlpha text.",
    "Title: Second\nURL: https://b.example/2\nPublished: N/A\nAuthor: N/A\nHighlights:\nBeta text.",
  ].join("\n\n");
  assert.deepEqual(parseResults(text), [
    { title: "First", url: "https://a.example/1", snippet: "Alpha text.", publishedDate: "2026-10-01" },
    { title: "Second", url: "https://b.example/2", snippet: "Beta text.", publishedDate: undefined },
  ]);
});

test("live search returns results", { skip: !process.env.PI_DISTRO_LIVE_TESTS }, async () => {
  const results = await provider.search({ query: "gufo strix halo inference engine", maxResults: 3 });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.url.startsWith("http")));
});
