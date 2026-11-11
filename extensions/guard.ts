/**
 * A deny layer for commands that cannot be undone.
 *
 * pi asks no approval before running a tool, so the blast radius of a bad `bash`
 * call is the whole machine. Plan mode already restricts commands to a
 * read-only allowlist, but that only applies while you are planning. This guard
 * is always on, and it denies a *specific list of irreversible operations*
 * rather than allowing a list of safe ones.
 *
 * That distinction is the whole design. An allowlist is a usability tool, not a
 * boundary: `Bash(rm *)` does not stop `/bin/rm`, compound commands split on
 * `&&` and are judged per stage, and `git -c core.pager=…` turns an allowlisted
 * `git` into a program launcher. A short deny list of things that destroy work
 * is small enough to reason about and cannot be widened by a new command.
 *
 * What it stops, from the incidents rather than from theory:
 *
 * - `rm -rf` outside the workspace (a real agent deleted `$HOME`)
 * - force-push and history rewrite (a real force-push collapsed a remote to one
 *   commit; this is the one class that local git cannot undo)
 * - `git clean -fdx`, `git reset --hard`, `git checkout -- .` (uncommitted work)
 * - writes into `.git` (hooks run arbitrary code on your next command)
 * - reading or writing credential files (2,539 keys were found in public repos
 *   after agents read and later committed them)
 * - `chmod -R`/`chown -R` on a broad path, `dd of=`, `mkfs`, fork bombs
 *
 * A denial is returned to the model with the reason, so it can choose a
 * different route instead of retrying.
 *
 * This is not a sandbox. It cannot see what a build script does, and a determined
 * prompt injection can still encode a command it never names literally. It
 * raises the cost of an accident; `pi-sandbox` or a container is what contains a
 * deliberate attack.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stages, type Stage } from "./shell-parse.ts";

export interface Denial {
  reason: string;
}

/** Paths whose contents are credentials, not project files. */
const SECRET_PATHS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.env(\.(?!example|sample|template)[\w.-]+)?$/,
];

/** Whether a path names a credential store. `.env.example` is not one. */
export const isSecretPath = (value: string): boolean => SECRET_PATHS.some((re) => re.test(value));

/** Where the workspace ends: writes outside it are treated as outside the blast radius we accept. */
function workspaceRoot(cwd: string): string {
  const home = os.homedir();
  const resolved = path.resolve(cwd);
  // A session started at or above $HOME would make "inside the workspace" mean
  // "the whole home directory"; treat $HOME as the boundary in that case.
  if (resolved === home || resolved === path.parse(resolved).root || home.startsWith(`${resolved}${path.sep}`)) return home;
  return resolved;
}

/** Whether a path argument resolves outside the workspace. */
function outsideWorkspace(value: string, cwd: string): boolean {
  if (!value || value.startsWith("-")) return false;
  // Shell expansions cannot be resolved here; treat `$VAR` and `~` as outside,
  // because `rm -rf $HOME` is exactly the case that matters.
  if (/^[$~]/.test(value)) return true;
  const target = path.resolve(cwd, value);
  const root = workspaceRoot(cwd);
  return target !== root && !target.startsWith(`${root}${path.sep}`);
}

/** The `-n` in `-rf`, `--recursive`, `-R`, as booleans. */
const flagsOf = (args: string[]) => {
  const short = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
  return {
    recursive: /[rR]/.test(short) || args.includes("--recursive"),
    force: /f/.test(short) || args.includes("--force"),
    all: /[aA]/.test(short) || args.includes("--all"),
  };
};

/** Every argument that looks like a path, so `rm -rf a b` is judged on both. */
const pathArgs = (args: string[]): string[] => args.filter((a) => !a.startsWith("-"));

function denyRm(stage: Stage, cwd: string): Denial | undefined {
  const { recursive, force } = flagsOf(stage.args);
  const targets = pathArgs(stage.args);
  if (targets.length === 0) return undefined;
  if (targets.some(isSecretPath)) return { reason: "deletes a credential directory" };
  const glob = targets.find((t) => /[?*]/.test(t));
  if (glob) return { reason: `deletes a glob (${glob}), which can match far more than intended` };
  const outside = targets.find((t) => outsideWorkspace(t, cwd));
  if (recursive && outside) return { reason: `recursively deletes ${outside}, which is outside the workspace` };
  // `rm -rf /` and `rm -rf ~` through a path this cannot expand.
  if (recursive && force && targets.some((t) => /^\/+$|^\/\*$/.test(t))) return { reason: "recursively deletes the filesystem root" };
  return undefined;
}

function denyGit(stage: Stage): Denial | undefined {
  // `git -c core.pager=… log` puts the override before the subcommand, so this
  // is checked over the whole argument list, not the part after the subcommand.
  if (stage.args.some((arg) => arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path"))) {
    return { reason: "passes a git option that makes git run an arbitrary program" };
  }
  const [sub, ...rest] = stage.args;
  if (sub === undefined) return undefined;
  const joined = rest.join(" ");
  if (sub === "push" && (rest.includes("--force") || rest.includes("-f") || rest.some((a) => /^--force-with-lease|^--mirror/.test(a)))) {
    return { reason: "force-pushes, which rewrites the remote and cannot be undone locally" };
  }
  if (sub === "push" && rest.some((a) => /^--delete$|^-d$|^:/.test(a))) {
    return { reason: "deletes a remote branch or tag" };
  }
  if (sub === "push" && rest.includes("--no-verify")) {
    return { reason: "pushes with --no-verify, bypassing the hooks that guard the remote" };
  }
  if (sub === "reset" && (rest.includes("--hard") || rest.includes("--keep"))) {
    return { reason: "discards uncommitted work with git reset --hard" };
  }
  if (sub === "clean" && flagsOf(rest).force) {
    return { reason: "deletes untracked files with git clean -f" };
  }
  if (sub === "checkout" && (rest.includes("--") || joined.includes(" .")) && rest.includes(".")) {
    return { reason: "discards uncommitted changes with git checkout -- ." };
  }
  if (sub === "restore" && !rest.includes("--staged")) {
    return { reason: "discards uncommitted changes with git restore" };
  }
  if (sub === "filter-branch" || sub === "filter-repo") return { reason: "rewrites git history" };
  if (sub === "reflog" && rest.includes("expire")) return { reason: "expires the reflog, the last way back from a bad reset" };
  if (sub === "update-ref" && rest.some((a) => a === "-d")) return { reason: "deletes a git ref" };
  return undefined;
}

function denyFilesystem(stage: Stage, cwd: string): Denial | undefined {
  const { name } = stage;
  const args = stage.args;
  if (name === undefined) return undefined;
  if (name === "dd" && args.some((a) => /^of=/.test(a) && outsideWorkspace(a.slice(3), cwd))) {
    return { reason: "writes a raw device or path outside the workspace with dd" };
  }
  if (/^mkfs(\.|$)/.test(name) || name === "fdisk" || name === "parted") return { reason: "formats or repartitions a disk" };
  if ((name === "chmod" || name === "chown" || name === "chgrp") && flagsOf(args).recursive) {
    const targets = pathArgs(args.filter((a) => !/^[0-7]+$|^[ugoa]+[+-]/.test(a)));
    if (targets.some((t) => outsideWorkspace(t, cwd) || t === "/" )) return { reason: `recursively changes ${name} outside the workspace` };
  }
  if (name === "truncate" && args.some((a) => outsideWorkspace(a, cwd))) return { reason: "truncates a file outside the workspace" };
  if (name === "shred") return { reason: "irreversibly destroys a file" };
  if (name === "mv" && args.some((a) => isSecretPath(a))) return { reason: "moves a credential file" };
  if (name === "sudo" || name === "doas") return { reason: "escalates privileges" };
  return undefined;
}

/** Anything in a stage that writes into a path the guard protects. */
function denyProtectedWrite(stage: Stage): Denial | undefined {
  const all = [...stage.args, ...stage.env];
  if (all.some((a) => /(^|\/)\.git\//.test(a) && !/^--/.test(a))) {
    // Writing a hook or config into .git runs code on the next git command.
    if (stage.name === "echo" || stage.name === "printf" || stage.name === "tee" || stage.name === "cat" || stage.name === "cp" || stage.name === "mv") {
      return { reason: "writes into .git, where hooks and config run commands on your behalf" };
    }
  }
  if (all.some(isSecretPath)) {
    // Reading credentials is how they end up in a transcript and then a commit.
    if (stage.name === "cat" || stage.name === "head" || stage.name === "tail" || stage.name === "less" || stage.name === "more" || stage.name === "tee" || stage.name === "cp" || stage.name === "scp") {
      return { reason: "reads or copies a credential file into the session" };
    }
  }
  return undefined;
}

/** Wrappers whose arguments are themselves a command, which must be judged too. */
const WRAPPERS = new Set(["xargs", "env", "nohup", "time", "timeout", "nice", "command", "exec", "builtin"]);

/**
 * A stage whose arguments run another command — `xargs rm -rf /`, `env X=1 rm`,
 * `sh -c "rm -rf /"` — expressed as the inner command to judge.
 *
 * Without this, wrapping a destructive command in a harmless binary walks past
 * the whole guard.
 */
function innerCommand(stage: Stage): string | undefined {
  const { name, args } = stage;
  if (name === undefined) return undefined;
  if (/^(ba|da|z|k|fi)?sh$/.test(name)) {
    const i = args.findIndex((a) => a === "-c");
    return i !== -1 ? args[i + 1] : undefined;
  }
  if (WRAPPERS.has(name)) {
    // Skip the wrapper's own leading flags and `NAME=value` assignments, then
    // keep everything from the first real word: the inner command's own flags
    // matter (`xargs rm -rf /` is not `rm /`).
    let i = 0;
    while (i < args.length && (/^-/.test(args[i]) || /^\w+=/.test(args[i]))) i += 1;
    const rest = args.slice(i);
    return rest.length > 0 ? rest.join(" ") : undefined;
  }
  return undefined;
}

/** The denial for one shell command, or undefined when nothing irreversible is in it. */
export function checkCommand(command: string, cwd: string): Denial | undefined {
  const parts = stages(command);
  // A command the scanner cannot model is not denied for that reason alone —
  // plan mode already fails closed on those, and denying everything unparseable
  // would block ordinary shells syntax. Judge each stage we can see.
  if (!parts) return undefined;
  for (const stage of parts) {
    const denial =
      (stage.name === "rm" || stage.name === "unlink" || stage.name === "rmdir" ? denyRm(stage, cwd) : undefined) ??
      (stage.name === "git" ? denyGit(stage) : undefined) ??
      denyFilesystem(stage, cwd) ??
      denyProtectedWrite(stage);
    if (denial) return denial;
    // `xargs rm -rf /` and `sh -c "rm -rf /"` carry the real command inside.
    const inner = innerCommand(stage);
    if (inner !== undefined) {
      const viaInner = checkCommand(inner, cwd);
      if (viaInner) return viaInner;
    }
  }
  // A fork bomb names no binary the scanner recognises.
  if (/:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/.test(command)) return { reason: "is a fork bomb" };
  return undefined;
}

/** The denial for a write/edit tool call, or undefined. */
export function checkWrite(target: string): Denial | undefined {
  if (/(^|\/)\.git\/(hooks|config)(\/|$)/.test(target)) {
    return { reason: "writes into .git, where hooks and config run commands on your behalf" };
  }
  if (isSecretPath(target)) return { reason: "writes to a credential file" };
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const off = process.env.PI_DISTRO_GUARD === "off";

  pi.on("tool_call", (event, ctx) => {
    // Escape hatch for scripted runs; the guard is on by default.
    if (off) return;
    const input = event.input as { command?: unknown; path?: unknown };
    let denial: Denial | undefined;
    if (event.toolName === "bash" && typeof input.command === "string") {
      denial = checkCommand(input.command, ctx.cwd);
    } else if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") {
      denial = checkWrite(input.path);
    }
    if (!denial) return;
    // Blocked, with the reason, so the model can pick another route instead of
    // retrying the same call. `terminate` is deliberately not set: this is one
    // bad command, not a reason to end the turn.
    return {
      block: true,
      reason: `Blocked by the pi-distro guard: this ${denial.reason}. If it is genuinely intended, run it yourself or set PI_DISTRO_GUARD=off.`,
    };
  });
}
