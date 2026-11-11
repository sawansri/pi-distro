// The working-row timer's formatting.
//
//   node --test test/working-timer.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, workingLabel } from "../extensions/working-timer.ts";

test("seconds under a minute", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(800), "0s");
  assert.equal(formatElapsed(8_400), "8s");
  assert.equal(formatElapsed(59_900), "59s");
});

test("minutes are zero-padded so the width does not jump", () => {
  // A label that changes width every ten seconds makes the row twitch.
  assert.equal(formatElapsed(60_000), "1m00s");
  assert.equal(formatElapsed(65_000), "1m05s");
  assert.equal(formatElapsed(9 * 60_000 + 7_000), "9m07s");
  assert.equal(formatElapsed(59 * 60_000), "59m00s");
});

test("hours for a long run", () => {
  assert.equal(formatElapsed(60 * 60_000), "1h00m");
  assert.equal(formatElapsed(3 * 3_600_000 + 25 * 60_000), "3h25m");
});

test("a negative or absurd duration does not produce nonsense", () => {
  // Clock skew should not print "-1s" into the prompt bar.
  assert.equal(formatElapsed(-5_000), "0s");
});

test("the label is what the row shows", () => {
  assert.equal(workingLabel(12_000), "Working… 12s");
});
