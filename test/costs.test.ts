// The /costs accounting, against real session shapes.
//
//   node --test test/costs.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheShare, promptTokens, renderReport, spendByModel, spendBySubagent } from "../extensions/costs.ts";

const assistant = (model: string, usage: Record<string, number>) => ({
  type: "message",
  message: { role: "assistant", provider: "gateway", model, usage },
});

/** A subagent tool result exactly as pi-lite-subagent attaches it. */
const subagentResult = (results: unknown[]) => ({
  type: "message",
  message: { role: "toolResult", toolName: "subagent", details: { results } },
});

test("assistant messages are grouped by model, not by provider", () => {
  const byModel = spendByModel([
    assistant("gpt-6-luna", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
    assistant("gpt-6-luna", { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }),
    assistant("Claude-Sonnet-5-5", { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }),
  ]);
  assert.equal(byModel.get("gateway/gpt-6-luna")?.calls, 2);
  assert.equal(byModel.get("gateway/gpt-6-luna")?.input, 300);
  assert.equal(byModel.get("gateway/Claude-Sonnet-5-5")?.cost, 0.5);
});

test("a responseModel that differs from the requested model is what gets billed", () => {
  // The gateway answers from another deployment and reports it; the cost
  // belongs to the model that answered.
  const byModel = spendByModel([
    { type: "message", message: { role: "assistant", provider: "gateway", model: "asked", responseModel: "actual", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } },
  ]);
  assert.ok(byModel.has("gateway/actual"));
  assert.ok(!byModel.has("gateway/asked"));
});

test("cache share is of prompt tokens, and undefined when nothing was billed", () => {
  const spend = { input: 100, output: 0, cacheRead: 300, cacheWrite: 0, cost: 0, calls: 1 };
  assert.equal(promptTokens(spend), 400);
  assert.equal(cacheShare(spend), 0.75);
  assert.equal(cacheShare({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 1 }), undefined);
});

test("cache writes count toward the prompt, not against the cache share", () => {
  // A session whose prompt is written once and read back is well cached.
  const spend = { input: 0, output: 0, cacheRead: 300, cacheWrite: 100, cost: 0, calls: 2 };
  assert.equal(promptTokens(spend), 400);
  assert.equal(cacheShare(spend), 0.75);
});

test("subagent tasks come from the tool result's details, with turns and status", () => {
  const subs = spendBySubagent([
    subagentResult([
      { agent: "explore", task: "find the allowlist", exitCode: 0, model: "DeepSeek-V4.1-Flash",
        usage: { input: 900, output: 100, cacheRead: 3000, cacheWrite: 0, cost: 0.002, turns: 4, contextTokens: 8000 } },
      { agent: "reviewer", task: "review the diff", exitCode: 1, model: "gpt-6.1-sol",
        usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.004, turns: 2 } },
    ]),
  ]);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].status, "ok");
  assert.equal(subs[0].turns, 4);
  assert.equal(subs[1].status, "failed");
  // A task still running reports no exit code yet.
  const running = spendBySubagent([subagentResult([{ agent: "plan", task: "x", usage: { cost: 0 } }])]);
  assert.equal(running[0].status, "running");
});

test("the report lists models by cost and totals them", () => {
  const lines = renderReport([
    assistant("gpt-6-luna", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
    assistant("Claude-Sonnet-5-5", { input: 50, output: 5, cacheRead: 500, cacheWrite: 0, cost: { total: 0.5 } }),
  ]);
  const text = lines.join("\n");
  assert.match(text, /^model/m);
  // Most expensive first: the point is to see what dominates.
  assert.ok(text.indexOf("Claude-Sonnet-5-5") < text.indexOf("gpt-6-luna"), text);
  assert.match(text, /total/);
  // 500 of Sonnet's 550 prompt tokens were cache reads, and 500 of 650 overall.
  assert.match(text, /91%/);
  assert.match(text, /77%/);
});

test("an empty session says so instead of printing a bare header", () => {
  assert.deepEqual(renderReport([]), ["No usage recorded in this session yet."]);
});

test("a malformed entry is skipped rather than throwing", () => {
  const lines = renderReport([null, { type: "message" }, { type: "message", message: { role: "assistant" } }]);
  assert.deepEqual(lines, ["No usage recorded in this session yet."]);
});
