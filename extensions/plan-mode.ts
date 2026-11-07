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

/** Splits a command into words as the shell does, removing quotes: `-"de"lete` is `-delete`. */
const words = (command: string) =>
  (command.match(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g) ?? []).map((word) => word.replace(/'([^']*)'|"([^"]*)"/g, "$1$2"));

function isReadOnlyStage(stage: string): boolean {
  const [name, ...args] = words(stage.replace(/^(\w+=\S*\s+)+/, ""));
  if (name === undefined) return true;
  if (name === "git") {
    const [sub, ...rest] = args;
    const allowed = sub !== undefined ? GIT[sub] : undefined;
    return allowed !== undefined && rest.every((arg) => allowed.test(arg));
  }
  if (name === "uniq") return args.every((arg) => arg.startsWith("-"));
  if (!(name in READERS)) return false;
  const denied = READERS[name];
  return denied === null || !args.some((arg) => denied.test(arg));
}

/** Replaces the inside of quoted strings with spaces, so operators in them are ignored but positions stay put. */
const mask = (command: string, quotes: RegExp) => command.replace(quotes, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);

/** Whether a bash command only reads: every stage is a reader, and nothing writes to a file or runs a substitution. */
export function isReadOnly(command: string): boolean {
  // Substitutions run inside double quotes too; only single quotes are inert.
  if (/[<>]\(|\$\(|`/.test(mask(command, /'[^']*'/g))) return false;
  // Allow only redirections that write nowhere, 2>&1 and >/dev/null, blanked out before splitting on & and |.
  const harmless = (text: string) => text.replace(/\d*>&\d+|\d*>\s*\/dev\/null/g, (m) => " ".repeat(m.length));
  const masked = harmless(mask(command, /'[^']*'|"[^"]*"/g));
  if (/>/.test(masked)) return false;
  command = harmless(command);
  const stages: string[] = [];
  let from = 0;
  for (const separator of masked.matchAll(/&&|\|\||[;|&\n]/g)) {
    stages.push(command.slice(from, separator.index));
    from = separator.index! + separator[0].length;
  }
  stages.push(command.slice(from));
  return stages.map((stage) => stage.trim()).every(isReadOnlyStage);
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
  // A subagent started while its parent was planning stays read-only.
  const inherited = process.env[ENV] === "1";
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

  pi.on("session_start", (_event, ctx) => {
    if (inherited) return;
    const last = ctx.sessionManager
      .getBranch()
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY)
      .pop() as { data?: { on?: unknown } } | undefined;
    apply(ctx, last?.data?.on === true);
  });

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
