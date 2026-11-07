import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnly } from "../extensions/plan-mode.ts";

test("read-only commands pass", () => {
  for (const command of [
    "ls -la",
    "cat src/a.ts | head -20",
    "rg -n foo src && git status",
    "git log --oneline -5",
    "find . -name '*.ts' | wc -l",
    "grep -r x . 2>&1 | sort | uniq -c",
    "LC_ALL=C sort file",
    "sed -n 1,20p a.txt",
  ]) {
    assert.equal(isReadOnly(command), true, command);
  }
});

test("commands that write or aren't allowlisted are blocked", () => {
  for (const command of [
    "rm -rf build",
    "echo hi > a.txt",
    "cat a >> b",
    "ls; rm a",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "sed -i s/a/b/ f",
    "git commit -m x",
    "git push",
    "npm install",
    "cat $(echo a)",
    "python3 -c 'open(\"x\",\"w\")'",
    "cat a | tee b",
  ]) {
    assert.equal(isReadOnly(command), false, command);
  }
});
