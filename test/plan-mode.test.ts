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
    "git branch -a",
    "git remote -v",
    "git tag --list",
    "cat a 2>&1 >/dev/null",
    "grep -o foo a.txt | sort | uniq -c",
    "fd -e ts src",
    "rg -n \"foo|bar\" src",
    "grep '>' a.txt",
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
    "ls & rm -rf build",
    "cat <(rm -rf build)",
    "cat a 1>b",
    "grep x . 2>err.log",
    "env rm -rf build",
    "awk 'BEGIN{system(\"rm x\")}'",
    "sed -n '1w out' a",
    "fd . -x rm",
    "rg --pre ./cmd foo",
    "find . -fls out",
    "sort -o f a",
    "sort --output=f a",
    "uniq in out",
    "tree -o f",
    "git branch -D main",
    "git branch new-branch",
    "git tag -d v1",
    "git tag v2",
    "git remote remove origin",
    "git diff --output=f",
    "echo \"$(rm x)\"",
  ]) {
    assert.equal(isReadOnly(command), false, command);
  }
});
