// The destructive-operation guard: what it blocks, and what it must not.
//
//   node --test test/guard.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkCommand, checkWrite, isSecretPath } from "../extensions/guard.ts";

const cwd = "/home/dev/project";
const blocked = (command: string) => checkCommand(command, cwd) !== undefined;
const allowed = (command: string) => checkCommand(command, cwd) === undefined;

test("removing the home directory or the filesystem is blocked", () => {
  // A real agent ran `rm -rf` on $HOME. Expansion cannot be resolved here, so
  // the guard treats `$VAR` and `~` as outside the workspace.
  assert.ok(blocked("rm -rf ~"));
  assert.ok(blocked("rm -rf $HOME"));
  assert.ok(blocked("rm -rf /"));
  assert.ok(blocked("rm -rf /*"));
  assert.ok(blocked("rm -rf ../other-project"));
  assert.ok(blocked("rm -rf /etc"));
});

test("ordinary in-workspace cleanup still works", () => {
  assert.ok(allowed("rm -rf node_modules"));
  assert.ok(allowed("rm -rf dist build"));
  assert.ok(allowed("rm file.txt"));
  assert.ok(allowed("rm -rf ./tmp/cache"));
});

test("a glob is blocked because it can match far more than intended", () => {
  assert.ok(blocked("rm -rf *"));
  assert.ok(blocked("rm -rf src/*"));
});

test("deleting credentials is blocked even inside the workspace", () => {
  assert.ok(blocked("rm -rf .ssh"));
  assert.ok(blocked("rm -rf ~/.ssh"));
  assert.ok(blocked("rm .env"));
  assert.ok(blocked("rm -rf .aws"));
  // A file called .env.example documents the variables; it is not a secret.
  assert.ok(allowed("rm .env.example"));
});

test("force-push and history rewrite are blocked", () => {
  assert.ok(blocked("git push --force"));
  assert.ok(blocked("git push -f origin main"));
  assert.ok(blocked("git push --force-with-lease origin main"));
  assert.ok(blocked("git push --mirror"));
  assert.ok(blocked("git push origin --delete feature"));
  assert.ok(blocked("git reset --hard HEAD~3"));
  assert.ok(blocked("git clean -fdx"));
  assert.ok(blocked("git checkout -- ."));
  assert.ok(blocked("git filter-branch --tree-filter x"));
  assert.ok(blocked("git reflog expire --expire=now --all"));
});

test("ordinary git still works", () => {
  assert.ok(allowed("git push"));
  assert.ok(allowed("git push origin main"));
  assert.ok(allowed("git reset HEAD file.txt"));
  assert.ok(allowed("git clean -nd"));
  assert.ok(allowed("git status"));
  assert.ok(allowed("git log --oneline -5"));
  assert.ok(allowed("git checkout feature-branch"));
  assert.ok(allowed("git restore --staged file.txt"));
});

test("a git config override is blocked, since it can launch a program", () => {
  // `git -c core.pager=… log` runs your command; this is the argument-injection
  // class that defeats a plain `git` allowlist.
  assert.ok(blocked("git -c core.pager=sh log"));
  assert.ok(blocked("git -c diff.external=/tmp/x diff"));
});

test("the command is split into stages, so a wrapper does not hide it", () => {
  assert.ok(blocked("cd /tmp && rm -rf ~"));
  assert.ok(blocked("echo hi; git push --force"));
  assert.ok(blocked("true || rm -rf /etc"));
  assert.ok(blocked("ls | xargs rm -rf /"));
  // A dangerous word inside quotes is text, not a command.
  assert.ok(allowed('echo "git push --force"'));
  assert.ok(allowed("git commit -m 'reset --hard is not run here'"));
});

test("privilege escalation and disk operations are blocked", () => {
  assert.ok(blocked("sudo rm file"));
  assert.ok(blocked("mkfs.ext4 /dev/sda1"));
  assert.ok(blocked("dd if=/dev/zero of=/dev/sda"));
  assert.ok(blocked("shred secrets.txt"));
});

test("writes into .git are blocked, because hooks run programs", () => {
  assert.ok(checkWrite(".git/hooks/pre-commit") !== undefined);
  assert.ok(checkWrite("/home/dev/project/.git/config") !== undefined);
  // Ordinary files in the repo are fine.
  assert.equal(checkWrite("src/index.ts"), undefined);
  assert.equal(checkWrite(".github/workflows/ci.yml"), undefined);
});

test("writing a credential file is blocked", () => {
  assert.ok(checkWrite(".env") !== undefined);
  assert.ok(checkWrite("config/.env.production") !== undefined);
  assert.equal(checkWrite(".env.example"), undefined);
  assert.equal(checkWrite("docs/environment.md"), undefined);
});

test("credential paths are recognised, and lookalikes are not", () => {
  assert.ok(isSecretPath("/home/dev/.ssh/id_ed25519"));
  assert.ok(isSecretPath(".npmrc"));
  assert.ok(isSecretPath(".env.local"));
  assert.ok(!isSecretPath("src/environment.ts"));
  assert.ok(!isSecretPath("docs/.env.sample"));
});

test("a command the scanner cannot model is not silently denied", () => {
  // Plan mode already fails closed on these; the guard's job is the deny list,
  // and blocking every unparseable string would break ordinary work.
  assert.ok(allowed("echo $'a\\tb'"));
});

test("the sandbox launcher never grants read access to ~/.ssh", () => {
  // Granting ~/.ssh read makes private keys readable to the agent, which
  // re-opens the hole the sandbox exists to close. It was in the first version
  // of the launcher, so this test pins the fix.
  const script = readFileSync(new URL("../scripts/sandbox.sh", import.meta.url), "utf8");
  const grants = script
    .split("\n")
    .filter((line) => /set -- "\$@" --(read|allow|read-file|allow-file)/.test(line) && !line.trim().startsWith("#"));
  assert.ok(grants.length > 0, "expected the launcher to make grants");
  for (const line of grants) {
    assert.doesNotMatch(line, /\.ssh/, `launcher grants ~/.ssh: ${line.trim()}`);
  }
});

test("setting a git config key that runs a program is blocked", () => {
  // These come from .git/config, not from the command, so a permitted read like
  // `git log -p` executes them. Verified on git 2.43: with diff.external,
  // core.fsmonitor and a textconv driver all configured, log -p, show, blame,
  // status and diff each ran the payload.
  assert.ok(blocked("git config diff.external /tmp/x"));
  assert.ok(blocked("git config core.fsmonitor /tmp/x"));
  assert.ok(blocked("git config diff.mydrv.textconv /tmp/x"));
  assert.ok(blocked("git config --global core.pager /tmp/x"));
  assert.ok(blocked("git config --local core.sshCommand /tmp/x"));
  // Ordinary config is fine.
  assert.ok(allowed("git config user.name me"));
  assert.ok(allowed("git config --get user.email"));
});

test("a diff driver or hook written straight into the files is blocked", () => {
  // The same bypass without `git config`.
  assert.ok(checkWrite(".gitattributes") !== undefined);
  assert.ok(checkWrite("sub/.gitattributes") !== undefined);
  assert.ok(blocked("echo '*.txt diff=x' > .gitattributes"));
});
