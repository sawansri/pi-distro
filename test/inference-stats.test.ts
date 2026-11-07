import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, formatRequest, parsePrometheus, requestStats } from "../extensions/inference-stats.ts";

// A Chat Completions usage object from gufo 0.31 (component_cache omitted).
const gufoUsage = {
  prompt_tokens: 1115,
  completion_tokens: 25,
  prompt_tokens_details: { cached_tokens: 0 },
  draft_tokens: 40,
  draft_tokens_accepted: 30,
  gufo: { prefill_tokens: 1115, prefill_ms: 2956.7, decode_ms: 2500, ttft_ms: 2972.7, queue_ms: 1.9 },
};

test("reads gufo's per-request measurements", () => {
  const s = requestStats(gufoUsage)!;
  assert.equal(s.prefillTokens, 1115);
  assert.equal(s.decodeTokens, 25);
  assert.equal(formatRequest(s), "pp 1.1k @ 377 t/s · tg 25 @ 10.0 t/s · ttft 3.0s · draft 75%");
});

test("a fully cached prompt shows as cached", () => {
  const s = requestStats({ ...gufoUsage, draft_tokens: 0, gufo: { ...gufoUsage.gufo, prefill_tokens: 0, prefill_ms: 0, ttft_ms: 10.2 } })!;
  assert.equal(formatRequest(s), "pp cached · tg 25 @ 10.0 t/s · ttft 10ms");
});

test("falls back to llama-server timings", () => {
  const s = requestStats({ prompt_tokens: 10 }, { prompt_n: 500, prompt_ms: 250, predicted_n: 100, predicted_ms: 2000, cache_n: 20 })!;
  assert.equal(formatRequest(s), "pp 500 @ 2.0k t/s · tg 100 @ 50.0 t/s · ttft 250ms");
});

test("no server measurements gives nothing", () => {
  assert.equal(requestStats({ prompt_tokens: 10, completion_tokens: 2 }), undefined);
});

test("parses Prometheus counters and gauges", () => {
  const m = parsePrometheus(
    "# HELP llamacpp:prompt_tokens_total x\n# TYPE llamacpp:prompt_tokens_total counter\nllamacpp:prompt_tokens_total 79610\nllamacpp:kv_cache_usage_ratio 0.25\n",
  );
  assert.equal(m.get("llamacpp:prompt_tokens_total"), 79610);
  assert.equal(m.get("llamacpp:kv_cache_usage_ratio"), 0.25);
});

test("compact numbers", () => {
  assert.deepEqual([compact(9.86), compact(377.1), compact(1801), compact(16245)], ["9.9", "377", "1.8k", "16k"]);
});

test("live progress: prefill, then decode with a rate between mid-decode samples", async () => {
  const { busySlots, liveLine } = await import("../extensions/inference-stats.ts");
  const slot = (decoded: number, processed: number) => ({
    id_task: 241,
    n_prompt_tokens: 3059,
    n_prompt_tokens_cache: 1000,
    n_prompt_tokens_processed: processed,
    next_token: [{ n_decoded: decoded }],
  });
  const [prefilling] = busySlots([slot(0, 1200), { id_task: -1 }], 0);
  assert.equal(liveLine(prefilling), "prefill 1.2k/2.1k");
  const [first] = busySlots([slot(10, 2059)], 1000);
  assert.equal(liveLine(first, prefilling), "decode 10");
  const [second] = busySlots([slot(26, 2059)], 2500);
  assert.equal(liveLine(second, first), "decode 26 @ 10.7 t/s");
});
