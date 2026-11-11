// The model catalogue import shared by the installer and /models-refresh.
//
//   node --test test/catalog.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { advertisedHeader, authHeaders, catalogModel, catalogProviders, fetchCatalog, isPlaceholder, mergeModels, servedApi } from "../extensions/catalog.ts";

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

test("the template is vendor-neutral: no subscription-key header by default", () => {
  // The header belongs to one vendor; the template ships a bearer token, which
  // most gateways accept. The README shows how to add a subscription-key header
  // back for a gateway that wants one.
  const template = JSON.parse(readFileSync(new URL("../config/models.template.json", import.meta.url), "utf8"));
  for (const [name, provider] of Object.entries(template.providers)) {
    const headers = Object.keys((provider as any).headers ?? {}).join(" ").toLowerCase();
    assert.doesNotMatch(headers, /ocp-apim|subscription-key/, `${name} carries a vendor header`);
  }
});

test("a configured subscription-key header is sent, and authHeaders honours it", () => {
  const headers = authHeaders({ apiKey: "$K", headers: { "Ocp-Apim-Subscription-Key": "$K" } }, { K: "secret" } as any);
  assert.equal(headers["Ocp-Apim-Subscription-Key"], "secret");
  // A bearer token is sent alongside; a gateway that wants only its own header
  // ignores it, and one that wants a bearer token gets it without extra config.
  assert.equal(headers.authorization, "Bearer secret");
});

test("a 401 that names the header it wants is retried with it", async () => {
  // This is what lets the template stay vendor-neutral: a gateway using a
  // subscription key advertises it in www-authenticate, so the catalogue is
  // recovered without hand-editing the template first.
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    const key = req.headers["ocp-apim-subscription-key"];
    if (key !== "secret") {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'AzureApiManagementKey realm="https://gw.test/",name="Ocp-Apim-Subscription-Key",type="header"');
      res.end(JSON.stringify({ statusCode: 401, message: "Access denied due to missing subscription key." }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [entry("recovered")] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const result = await fetchCatalog(url, { apiKey: "$K" }, { K: "secret" } as any);
  assert.deepEqual(result.entries?.map((m: any) => m.id), ["recovered"]);
  assert.equal(calls, 2, "expected the initial request plus one retry");
});

test("a 401 with no usable hint is reported, not retried blindly", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls += 1;
    res.statusCode = 401;
    // A hint that is not a plain header name must not be turned into a header.
    res.setHeader("www-authenticate", 'Basic realm="x",name="bad header\\r\\nX-Evil"');
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await fetchCatalog(url, { apiKey: "$K" }, { K: "secret" } as any);
  assert.equal(result.entries, undefined);
  assert.equal(calls, 1, "an unusable hint must not trigger a retry");
});

test("advertisedHeader only accepts a plain header name", () => {
  const withHeader = (v: string) => advertisedHeader({ headers: { get: () => v } });
  assert.equal(withHeader('Bearer realm="x",name="Ocp-Apim-Subscription-Key"'), "Ocp-Apim-Subscription-Key");
  assert.equal(withHeader('Basic realm="x",name="Bad Header"'), undefined);
  assert.equal(withHeader('Basic realm="x",name="X-Evil\\r\\nInjected"'), undefined);
  assert.equal(withHeader(""), undefined);
  assert.equal(withHeader(undefined as any), undefined);
});
