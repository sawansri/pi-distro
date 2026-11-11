// The model catalogue import shared by the installer and /models-refresh.
//
//   node --test test/catalog.test.ts

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { catalogModel, catalogProviders, fetchCatalog, isPlaceholder, mergeModels, servedApi } from "../extensions/catalog.ts";

const servers: http.Server[] = [];
after(() => servers.forEach((server) => server.close()));

/** A gateway that answers /models with `body` under `status`. */
async function gateway(status: number, body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  owned_by: "AzureOpenAI",
  capabilities: { chat: true, vision: false, responses: false },
  context_length: 100000,
  max_output_tokens: 8000,
  pricing: { input_per_million: 1, output_per_million: 2, cache_read_input_per_million: 0.1 },
  ...extra,
});

test("a model is declared on the api the catalogue says serves it", () => {
  // Sending a model to an api it isn't served on does not fail on a real
  // gateway: it answers from an unpinned pool and bills the asked-for name.
  assert.equal(servedApi(entry("chat-only")), "openai-completions");
  assert.equal(servedApi(entry("resp", { capabilities: { chat: true, responses: true } })), "openai-responses");
  assert.equal(servedApi(entry("claude", { owned_by: "AzureOpenAI-Anthropic" })), "anthropic-messages");
  // Not a chat model at all.
  assert.equal(servedApi(entry("embed", { capabilities: { chat: false } })), undefined);
});

test("catalogue prices and limits reach the model entry", () => {
  const model = catalogModel(entry("m"));
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
  assert.equal(model.contextWindow, 100000);
  assert.equal(model.maxTokens, 8000);
  // A cache lifetime is declared only where the price list sells one.
  assert.deepEqual(model.promptCache, { short: 300 });
});

test("maxTokens never exceeds the context window", () => {
  const model = catalogModel(entry("m", { context_length: 1000, max_output_tokens: 999999 }));
  assert.equal(model.maxTokens, 1000);
});

test("the anthropic root is derived when the caller gives only the openai url", () => {
  const providers = catalogProviders(
    [entry("chat"), entry("claude", { owned_by: "Anthropic" })],
    { gateway: { baseUrl: "https://llm-api.example.com/Unified/v1" }, "gateway-anthropic": {} },
    { gateway: "https://gw.dev/Unified/v1" },
  );
  // The OpenAI path keeps /v1; the Anthropic path is the root.
  assert.equal(providers.gateway.baseUrl, "https://gw.dev/Unified/v1");
  assert.equal(providers["gateway-anthropic"].baseUrl, "https://gw.dev/Unified");
});

test("fetchCatalog returns the entries, or an error and no entries", async () => {
  const ok = await fetchCatalog(await gateway(200, { data: [entry("a")] }), { apiKey: "k" });
  assert.deepEqual(ok.entries?.map((model: any) => model.id), ["a"]);

  const failed = await fetchCatalog(await gateway(500, { error: "boom" }), { apiKey: "k" });
  assert.equal(failed.entries, undefined);
  assert.match(failed.error ?? "", /500/);

  const empty = await fetchCatalog(await gateway(200, { data: [] }), { apiKey: "k" });
  assert.equal(empty.entries, undefined);
  assert.match(empty.error ?? "", /no models/);
});

test("fetchCatalog refuses to run without a key rather than send an anonymous request", async () => {
  const result = await fetchCatalog("https://gw.dev/v1", { apiKey: "$PI_DISTRO_TEST_UNSET_KEY" }, {
    PI_DISTRO_TEST_UNSET_KEY: "",
  } as Record<string, string>);
  assert.equal(result.entries, undefined);
  assert.match(result.error ?? "", /no API key/);
});

test("fetchCatalog is skipped entirely when the environment says so", async () => {
  const result = await fetchCatalog("https://gw.dev/v1", { apiKey: "k" }, { PI_DISTRO_NO_CATALOG: "1" });
  assert.match(result.error ?? "", /disabled/);
});

test("the template host is a placeholder, a real host is not", () => {
  assert.equal(isPlaceholder("https://llm-api.example.com/Unified/v1"), true);
  assert.equal(isPlaceholder("https://llm.example.com/v1"), false);
  assert.equal(isPlaceholder("not a url"), false);
});

test("a refresh replaces listed models and keeps the ones the catalogue omits", () => {
  // A hand-added model in the same provider is the user's, not the catalogue's.
  const existing = [
    { id: "listed", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } },
    { id: "mine", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  ];
  const merged = mergeModels(existing, [{ id: "listed", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }]);
  assert.deepEqual(merged.map((model) => model.id), ["listed", "mine"]);
  // The catalogue wins for the id it publishes: a stale price is replaced.
  assert.equal(merged[0].cost.input, 1);
});

test("--prune drops entries the catalogue no longer lists", () => {
  const merged = mergeModels([{ id: "mine" }], [{ id: "listed" }], true);
  assert.deepEqual(merged.map((model) => model.id), ["listed"]);
});
