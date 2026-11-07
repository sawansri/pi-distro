import assert from "node:assert/strict";
import { test } from "node:test";
import provider from "../providers/searxng.ts";

const url = process.env.PI_DISTRO_TEST_SEARXNG;

test("searches a live SearXNG instance", { skip: !url }, async () => {
  process.env.SEARXNG_BASE_URL = url;
  assert.equal(provider.isConfigured(), true);
  const results = await provider.search({ query: "gufo strix halo", maxResults: 5 });
  assert.ok(results.length > 0 && results.length <= 5);
  assert.ok(results.every((r) => r.url.startsWith("http")));
});
