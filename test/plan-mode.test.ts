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

test("git options that write files or run programs are blocked", () => {
  for (const command of [
    "git log --output=tracked.ts",
    "git log --output tracked.ts",
    "git show --output=f HEAD",
    "git diff --ext-diff",
    "git log -p --ext-diff",
    "git show --textconv HEAD:a.png",
    "git grep -O foo",
    "git grep --open-files-in-pager foo",
  ]) {
    assert.equal(isReadOnly(command), false, command);
  }
  for (const command of ["git log -p -5", "git show HEAD:a.ts", "git diff --stat HEAD~1", "git grep -n foo"]) {
    assert.equal(isReadOnly(command), true, command);
  }
});

test("quoting an option doesn't hide it", () => {
  for (const command of [
    'find . -name victim.txt "-delete"',
    "find . -name v -\"de\"lete",
    "sort '-o' f a",
    'fd . "-x" rm',
    'git log "--output=f"',
    "'git' log --output=f",
  ]) {
    assert.equal(isReadOnly(command), false, command);
  }
  assert.equal(isReadOnly('grep -n "foo bar" src/a.ts'), true);
});
