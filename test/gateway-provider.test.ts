// The gateway search provider's answer handling and its fallbacks.
//
//   node --test test/gateway-provider.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

const provider = (await import("../providers/gateway.ts")).default;

test("the provider announces itself as a configured cloud backend", () => {
  assert.equal(provider.name, "gateway");
  assert.equal(provider.tier, "cloud");
  assert.equal(typeof provider.search, "function");
  assert.equal(typeof provider.extract, "function");
});

test("isConfigured is false without a usable gateway in models.json", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
  try {
    // No models.json at all: the chain must skip this provider, not crash.
    assert.equal(provider.isConfigured(), false);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("search fails loudly when there is no gateway, so the chain moves on", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
  try {
    await assert.rejects(
      () => provider.search({ query: "anything", maxResults: 3 }),
      /cannot read|no gateway model/,
    );
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("extract falls back to a plain HTTP read when the model reports a failed fetch", async () => {
  const dir = "/nonexistent-agent-dir";
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  // With no gateway at all, extract must still try to read the URL itself
  // rather than hand the research agent a description of a failure.
  const server = (await import("node:http")).createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><head><title>Test Page</title></head><body><p>Hello from the test page.</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const page = await provider.extract(`http://127.0.0.1:${port}/`);
    assert.equal(page.provider, "gateway-fetch");
    assert.equal(page.title, "Test Page");
    assert.match(page.content, /Hello from the test page/);
    assert.ok(page.wordCount > 0);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});
