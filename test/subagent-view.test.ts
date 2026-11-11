// The live subagent panel's state folding and layout.
//
//   node --test test/subagent-view.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyResults, renderRows, rowsFromArgs } from "../extensions/subagent-view.ts";

const tasks = [
  { agent: "explore", task: "find the allowlist" },
  { agent: "researcher", task: "check the docs" },
];

test("rows appear from the tool arguments, before any output", () => {
  const rows = rowsFromArgs(tasks);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, "explore");
  assert.ok(rows.every((row) => row.status === "running"));
});

test("no tasks means no panel, rather than an empty box", () => {
  assert.deepEqual(rowsFromArgs(undefined), []);
  assert.deepEqual(renderRows([]), []);
});

test("a finished result marks its own row, matched by agent and task", () => {
  // Two explores in one call: matching on the agent alone would cross them over.
  const rows = rowsFromArgs([
    { agent: "explore", task: "find A" },
    { agent: "explore", task: "find B" },
  ]);
  const next = applyResults(rows, [
    { agent: "explore", task: "find B", exitCode: 0, model: "DeepSeek-V4.1-Flash" },
    { agent: "explore", task: "find A", exitCode: 1 },
  ], 1000);
  assert.equal(next[0].status, "failed");
  assert.equal(next[1].status, "ok");
  assert.equal(next[1].model, "DeepSeek-V4.1-Flash");
});

test("a task still running keeps its running status", () => {
  const rows = rowsFromArgs(tasks);
  const next = applyResults(rows, [{ agent: "explore", task: tasks[0].task }], 1000);
  assert.equal(next[0].status, "running");
  assert.equal(next[0].endedAt, undefined);
});

test("the header counts what is done and what is still running", () => {
  let rows = rowsFromArgs(tasks);
  const started = rows[0].startedAt;
  rows = applyResults(rows, [{ agent: "explore", task: tasks[0].task, exitCode: 0 }], started + 2000);
  const lines = renderRows(rows, started + 3000);
  assert.match(lines[0], /1\/2 done/);
  assert.match(lines[1], /\+.*explore/);
  assert.match(lines[2], /·.*researcher/);
});

test("a finished run is labelled done, not as a fraction", () => {
  let rows = rowsFromArgs(tasks);
  rows = applyResults(rows, [
    { agent: "explore", task: tasks[0].task, exitCode: 0 },
    { agent: "researcher", task: tasks[1].task, exitCode: 0 },
  ], 1000);
  assert.match(renderRows(rows, 2000)[0], /^subagents {2}2 done$/);
});

test("a long task is cut to one line so the panel stays short", () => {
  const rows = rowsFromArgs([{ agent: "explore", task: "a".repeat(200) }]);
  const lines = renderRows(rows, rows[0].startedAt);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("…"), lines[1]);
});

test("elapsed time is shown and rounds down to <1s", () => {
  const rows = rowsFromArgs([{ agent: "explore", task: "x" }]);
  assert.match(renderRows(rows, rows[0].startedAt + 300)[1], /<1s/);
  assert.match(renderRows(rows, rows[0].startedAt + 42_000)[1], /42s/);
});

test("an update with no results leaves the rows untouched", () => {
  const rows = rowsFromArgs(tasks);
  assert.deepEqual(applyResults(rows, undefined), rows);
  assert.deepEqual(applyResults(rows, []), rows);
});
