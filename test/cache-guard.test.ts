import assert from "node:assert/strict";
import { test } from "node:test";
import { missedTokens } from "../extensions/cache-guard.ts";

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
