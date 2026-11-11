/**
 * Plan mode without tools.
 *
 * `/plan` or shift+tab toggles it. While it is on:
 * - edit and write are blocked, and bash runs only commands on a read-only
 *   allowlist; a blocked call returns the reason to the model.
 * - Entering and leaving it append a short message to the conversation, so the
 *   system prompt and tool list stay unchanged and the prompt cache survives.
 * - Subagents inherit it through PI_DISTRO_PLAN_MODE and are read-only too.
 * - When the model ends a run with a `## Plan` heading, you're asked whether to
 *   implement it.
 *
 * It declares no tools, unlike plan-mode packages that add question and
 * completion tools to every request.
 *
 * pi binds shift+tab to the thinking-level cycle; the distro's keybindings.json
 * moves that to alt+t.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Stage, stages, writesFile } from "./shell-parse.ts";

const ENV = "PI_DISTRO_PLAN_MODE";
const ENTRY = "pi-distro-plan";

const ON_MESSAGE = [
  "Plan mode is on. Explore and plan, but don't change anything yet:",
  "- edit and write are blocked; bash runs only read-only commands (ls, cat, grep, rg, find, git status/log/diff/show, ...) without redirection.",
  "- Read the relevant code, then ask about anything that is the user's decision.",
  "- When the plan is ready, end your message with it under a `## Plan` heading: numbered steps naming the files to change, and how you'll verify the result.",
].join("\n");

const OFF_MESSAGE = "Plan mode is off: you may edit files and run commands again.";

/** Commands that only read, with the arguments that would make them write or run other commands. */
const READERS: Record<string, RegExp | null> = {
  ls: null, cat: null, head: null, tail: null, wc: null, file: null, stat: null, pwd: null, which: null,
  type: null, echo: null, printf: null, grep: null, egrep: null, cut: null, tr: null, diff: null, jq: null,
  du: null, df: null, uname: null, date: null, basename: null, dirname: null, realpath: null, readlink: null,
  rg: /^--pre/,
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  fd: /^(-x|-X|--exec|--exec-batch)/,
  sort: /^(-o|--output)/,
  tree: /^-o/,
};

/** git options that write a file (--output) or run other programs (external diff, textconv filters, a pager). */
const GIT_UNSAFE = /^(--output|--ext-diff|--textconv|-O|--open-files-in-pager)/;
const anyGitArg = new RegExp(`^(?!${GIT_UNSAFE.source.slice(1)})`);

/** git subcommands that only read; each of their other arguments must match the pattern. */
const GIT: Record<string, RegExp> = {
  status: /^/, "ls-files": /^/, "ls-tree": /^/, "rev-parse": /^/, describe: /^/,
  log: anyGitArg, show: anyGitArg, diff: anyGitArg, blame: anyGitArg, grep: anyGitArg, shortlog: anyGitArg,
  branch: /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose)$/,
  tag: /^(-l|--list)$/,
  remote: /^(-v|--verbose|get-url|show)$/,
};

function isReadOnlyStage(stage: Stage): boolean {
  // Variable prefixes like GIT_EXTERNAL_DIFF or PAGER can make a reader run programs; only locale ones are allowed.
  if (stage.env.some((assignment) => !/^(LANG|LC_\w+)=/.test(assignment))) return false;
  const { name, args } = stage;
  if (name === undefined) return true;
  if (name === "git") {
    // The neutralising overrides are ours, not the model's: skip them before
    // judging the subcommand, so a permitted read stays permitted.
    const stripped: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c" && /^(diff\.external|core\.fsmonitor|core\.sshCommand)=$/.test(args[i + 1] ?? "")) {
        i += 1;
        continue;
      }
      stripped.push(args[i]);
    }
    const [sub, ...rest] = stripped;
    const allowed = sub !== undefined ? GIT[sub] : undefined;
    return allowed !== undefined && rest.every((arg) => allowed.test(arg));
  }
  if (name === "uniq") return args.every((arg) => arg.startsWith("-"));
  if (!(name in READERS)) return false;
  const denied = READERS[name];
  return denied === null || !args.some((arg) => denied.test(arg));
}

/**
 * Flags that stop a repository's own config from running a program.
 *
 * `.git/config` and `.gitattributes` come with the clone, not from the command,
 * so `git log -p` on a repo you did not author can execute a `diff.external`,
 * a `core.fsmonitor` hook, or a `diff.<driver>.textconv` named in
 * `.gitattributes`. Verified on git 2.43: with all three configured, `log -p`,
 * `show`, `blame`, `status` and `diff` each ran the payload.
 *
 * Neutralising them costs nothing and is invisible in the output, so it is
 * applied to every git command plan mode allows rather than only the ones known
 * to be vulnerable.
 */
export const GIT_NEUTRALIZE = ["-c", "diff.external=", "-c", "core.fsmonitor=", "-c", "core.sshCommand="];

/** Add the neutralising overrides to a git invocation, along with --no-textconv. */
export function neutralizeGit(args: string[]): string[] {
  // `--no-textconv` is a subcommand flag, so it goes after the subcommand and
  // before the user's arguments; `-c` overrides go before everything.
  const [sub, ...rest] = args;
  if (sub === undefined) return [...GIT_NEUTRALIZE];
  const takesTextconv = ["log", "show", "diff", "blame", "grep", "shortlog"].includes(sub);
  const extra = takesTextconv && !rest.includes("--no-textconv") ? ["--no-textconv"] : [];
  return [...GIT_NEUTRALIZE, sub, ...extra, ...rest];
}

/**
 * Rewrite every `git` stage in a command so the repository's config cannot make
 * it run a program, leaving everything else untouched.
 *
 * Only whole words named `git` are considered, so `gitk` and `echo git` are not
 * rewritten; the stage splitter has already handled quoting.
 */
export function hardenGit(command: string): string {
  const parts = stages(command);
  if (!parts) return command;
  let out = command;
  // Right to left, so earlier offsets stay valid.
  for (const stage of [...parts].reverse()) {
    if (stage.name !== "git") continue;
    const at = out.lastIndexOf(stage.text);
    if (at === -1) continue;
    const safe = ["git", ...neutralizeGit(stage.args)].join(" ");
    out = out.slice(0, at) + safe + out.slice(at + stage.text.length);
  }
  return out;
}

/** Whether a bash command only reads: every stage is a reader, and nothing writes to a file or runs a substitution. */
export function isReadOnly(command: string): boolean {
  // Unparseable shells fail closed: a command this scanner does not model is not read-only.
  const parts = stages(command);
  if (!parts) return false;
  if (parts.some((stage) => writesFile(stage.masked))) return false;
  return parts.every((stage) => isReadOnlyStage(stage));
}

const lastText = (messages: readonly unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : "")).join("");
    }
  }
  return "";
};

export default function (pi: ExtensionAPI) {
  // A subagent started while its parent was planning stays read-only. In the
  // parent the variable may be left from an earlier session in this process
  // (/new, /resume and /reload reload extensions without a new process).
  const inherited = process.env[ENV] === "1" && Boolean(process.env.PI_SUBAGENT_DEPTH);
  let planning = inherited;
  let planText = "";

  function apply(ctx: ExtensionContext, on: boolean) {
    planning = on;
    if (on) process.env[ENV] = "1";
    else delete process.env[ENV];
    ctx.ui.setStatus("plan", on ? "⏸ plan mode" : undefined);
  }

  function toggle(ctx: ExtensionContext, on: boolean) {
    if (on === planning) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish before switching plan mode.", "warning");
      return;
    }
    apply(ctx, on);
    pi.appendEntry(ENTRY, { on });
    pi.sendMessage({ customType: ENTRY, content: on ? ON_MESSAGE : OFF_MESSAGE, display: false }, { triggerTurn: false });
  }

  /** Plan mode as last saved on the current branch. */
  function restore(ctx: ExtensionContext) {
    if (inherited) return;
    const last = ctx.sessionManager
      .getBranch()
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY)
      .pop() as { data?: { on?: unknown } } | undefined;
    apply(ctx, last?.data?.on === true);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration and planning)",
    handler: async (_args, ctx) => toggle(ctx, !planning),
  });

  pi.registerShortcut("shift+tab", {
    description: "Toggle plan mode",
    handler: async (ctx) => toggle(ctx, !planning),
  });

  pi.on("tool_call", (event) => {
    if (!planning) return;
    const name = event.toolName;
    if (name === "edit" || name === "write") {
      return { block: true, reason: "Plan mode is on: files can't be changed until the user approves a plan." };
    }
    if (name === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!isReadOnly(command)) {
        return {
          block: true,
          reason: "Plan mode is on: bash runs only read-only commands (ls, cat, grep, rg, find, git status/log/diff/show, ...), without redirection.",
        };
      }
      // Approving a command is not enough: the repository's own config can make
      // an approved read run a program. Rewrite every git invocation to
      // neutralise that, which plan mode can do because `tool_call` may mutate
      // the input.
      const hardened = hardenGit(command);
      if (hardened !== command) (event.input as { command: string }).command = hardened;
    }
  });

  pi.on("agent_end", (event) => {
    planText = planning ? lastText(event.messages) : "";
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!planning || inherited || event.aborted || !ctx.hasUI || !/^#{1,3}\s*plan\b/im.test(planText)) return;
    // Not awaited: pi waits for each agent_settled handler in turn, and the
    // question would hold back the others (such as notify) until it's answered.
    void ctx.ui.select("The plan is ready.", ["Implement it", "Keep planning"]).then((choice) => {
      if (choice !== "Implement it" || !planning) return;
      apply(ctx, false);
      pi.appendEntry(ENTRY, { on: false });
      pi.sendUserMessage("Plan approved. Plan mode is off: implement the plan above, then verify it.");
    });
  });
}
