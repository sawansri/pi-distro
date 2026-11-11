import assert from "node:assert/strict";
import { test } from "node:test";
import { missedTokens, snapshot } from "../extensions/cache-guard.ts";

test("an OpenAI Responses payload is compared on instructions, tools and input", () => {
  // The Responses API sends `instructions` and typed `input` items, not
  // `messages`. Reading only `messages` made the guard a silent no-op on every
  // openai-responses model, which is most of the gateway.
  const before = snapshot({
    instructions: "You are a coding agent.",
    tools: [{ type: "function", name: "read" }],
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  });
  const after = snapshot({
    instructions: "You are a coding agent.",
    tools: [{ type: "function", name: "read" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", name: "read", arguments: "{}" },
    ],
  });
  assert.ok(before && after);
  assert.equal(before.system, after.system);
  assert.equal(before.tools, after.tools);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
});

test("changing the Responses instructions is visible as a system-prompt change", () => {
  const before = snapshot({ instructions: "one", input: [{ role: "user", content: "hi" }] });
  const after = snapshot({ instructions: "two", input: [{ role: "user", content: "hi" }] });
  assert.ok(before && after);
  assert.notEqual(before.system, after.system);
});

test("reasoning effort is read from the Responses reasoning object", () => {
  const low = snapshot({ instructions: "x", input: "hi", reasoning: { effort: "low" } });
  const high = snapshot({ instructions: "x", input: "hi", reasoning: { effort: "high" } });
  assert.ok(low && high);
  assert.equal(low.effort, "low");
  assert.notEqual(low.effort, high.effort);
});

test("an Anthropic Messages payload is compared on system and messages", () => {
  const snap = snapshot({ system: "be nice", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.ok(snap);
  assert.equal(snap.messages.length, 1);
  assert.equal(snapshot({ system: "other", max_tokens: 10, messages: [] })?.system === snap.system, false);
});

test("an unknown payload is ignored rather than reported as a miss", () => {
  assert.equal(snapshot({ model: "x" }), undefined);
});

test("new content after the previous prompt is not a miss", () => {
  // Previous prompt 11,091 tokens plus a 139-token answer were reused; 5,015 tokens of tool output are new.
  assert.equal(missedTokens(16245, 11230, 11091), 0);
});

test("losing the cached prefix is a miss", () => {
  assert.equal(missedTokens(1588, 0, 1510), 1510);
  assert.equal(missedTokens(9000, 2048, 8000), 5952);
});

test("the first request of a session can't miss", () => {
  assert.equal(missedTokens(2951, 2048, undefined), 0);
});

test("a shorter prompt (compaction) can reuse at most itself", () => {
  assert.equal(missedTokens(3000, 0, 20000), 3000);
});

test("a Responses payload mixing messages and function calls is recognised", () => {
  const snap = snapshot({
    instructions: "be terse",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
  });
  assert.ok(snap, "the real Responses shape must produce a snapshot");
  assert.equal(snap.messages.length, 3);
});

test("a leading developer input item is attributed to the system prompt", () => {
  // Chat-style adapters put the system prompt in `input` rather than
  // `instructions`; it must still show up as a system-prompt change.
  const a = snapshot({ input: [{ role: "developer", content: "one" }, { role: "user", content: "hi" }] });
  const b = snapshot({ input: [{ role: "developer", content: "two" }, { role: "user", content: "hi" }] });
  assert.ok(a && b);
  assert.notEqual(a.system, b.system);
  assert.equal(a.messages.length, 1);
});

test("a shape that cannot be hashed is ignored instead of throwing", () => {
  // snapshot() runs inside before_provider_request, so a throw would fail the run.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(snapshot({ messages: [circular] }), undefined);
  assert.equal(snapshot({ messages: [1n] }), undefined);
  assert.equal(snapshot({ model: "x", tools: 1n }), undefined);
});

test("an input array of non-items is not mistaken for a conversation", () => {
  assert.equal(snapshot({ input: [null, 42] }), undefined);
});
