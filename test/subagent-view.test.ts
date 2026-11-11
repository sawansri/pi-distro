// The live subagent panel's state folding and layout.
//
//   node --test test/subagent-view.test.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { applyResults, childSessionDir, newestSessionFile, panelVisible, renderRows, rowAtLine, rowsFromArgs } from "../extensions/subagent-view.ts";

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

test("rows line up in fixed columns, so the eye can scan one field at a time", () => {
  let rows = rowsFromArgs([
    { agent: "explore", task: "a" },
    { agent: "researcher", task: "b" },
  ]);
  rows = applyResults(rows, [{ agent: "explore", task: "a", exitCode: 0, model: "DeepSeek-V4.1-Flash" }], 1000);
  const lines = renderRows(rows, 2000);
  // The task text must start at the same column whether or not a model is shown.
  const taskColumn = (line: string) => line.indexOf(line.trim().split(/\s+/).slice(-1)[0].slice(0, 1));
  assert.equal(lines[1].indexOf("(2s)"), lines[2].indexOf("(2s)"));
  assert.ok(taskColumn(lines[1]) >= 0);
});

test("a click maps to its row, and misses land on nothing", () => {
  // Line 0 is the header, so row i is drawn at y = i + 1.
  assert.equal(rowAtLine(0, 3), -1, "the header is not a row");
  assert.equal(rowAtLine(1, 3), 0);
  assert.equal(rowAtLine(3, 3), 2);
  assert.equal(rowAtLine(4, 3), -1, "past the last row");
  assert.equal(rowAtLine(-1, 3), -1);
});

test("the selected row is marked, so the keyboard path has a cursor", () => {
  const rows = rowsFromArgs([{ agent: "explore", task: "a" }, { agent: "reviewer", task: "b" }]);
  const plain = renderRows(rows, rows[0].startedAt);
  const marked = renderRows(rows, rows[0].startedAt, 1);
  assert.match(plain[1], /^ {2}·/);
  assert.match(marked[2], /^> ·/, marked[2]);
});

test("a child's session file is found while it is still being written", async () => {
  // The click target must exist for a running subagent, not only a finished one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-distro-child-"));
  const dir = childSessionDir(root, "session-1");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(newestSessionFile(dir), undefined, "no file yet");
  const first = path.join(dir, "a.jsonl");
  fs.writeFileSync(first, "{}\n");
  assert.equal(newestSessionFile(dir), first);
  // A second child in the same parent session: the newest wins.
  const second = path.join(dir, "b.jsonl");
  fs.writeFileSync(second, "{}\n");
  const now = Date.now() / 1000;
  fs.utimesSync(second, now + 5, now + 5);
  assert.equal(newestSessionFile(dir), second);
  // A directory that does not exist is not an error.
  assert.equal(newestSessionFile(path.join(root, "missing")), undefined);
});

test("the child session directory is the one the package writes", () => {
  assert.equal(childSessionDir("/s", "abc"), path.join("/s", "lite-subagent", "abc"));
});

test("the panel appears with a fan-out and leaves with it", () => {
  // Auto: nothing on screen until subagents are actually working.
  assert.equal(panelVisible("auto", false), false);
  assert.equal(panelVisible("auto", true), true);
});

test("pinned keeps the panel between runs, off keeps it away", () => {
  assert.equal(panelVisible("pinned", false), true);
  assert.equal(panelVisible("pinned", true), true);
  assert.equal(panelVisible("off", false), false);
  assert.equal(panelVisible("off", true), false);
});
