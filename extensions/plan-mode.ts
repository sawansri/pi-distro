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
  "- edit and write are blocked; bash runs only read-only commands (ls, cat, grep, rg, find, git status/log/diff/show, ...).",
  "- Read the relevant code, then ask about anything that is the user's decision.",
  "- When the plan is ready, end your message with it under a `## Plan` heading: numbered steps naming the files to change, and how you'll verify the result.",
].join("\n");

const OFF_MESSAGE = "Plan mode is off: you may edit files and run commands again.";

const READ_ONLY = new RegExp(
  "^(" +
    [
      "ls", "cat", "head", "tail", "wc", "file", "stat", "tree", "pwd", "which", "type", "echo", "printf",
      "grep", "egrep", "rg", "ag", "find", "fd", "sed -n", "awk", "sort", "uniq", "cut", "tr", "diff", "jq",
      "du", "df", "uname", "env", "date", "basename", "dirname", "realpath", "readlink",
      "git (status|log|diff|show|blame|branch|grep|ls-files|ls-tree|rev-parse|remote|tag|describe|shortlog)",
      "npm (ls|view|outdated|explain)", "cargo (tree|metadata)", "go (list|doc|env)",
    ].join("|") +
    ")(\\s|$)",
);

/** Whether a bash command only reads: every pipeline stage is allowlisted and nothing is redirected to a file. */
export function isReadOnly(command: string): boolean {
  if (/(^|[^0-9&<])>(?!&)|>>|\$\(|`/.test(command)) return false;
  if (/\bfind\b.*\s-(delete|exec|execdir|ok|fprint)/.test(command)) return false;
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => READ_ONLY.test(part.replace(/^(\w+=\S*\s+)+/, "")));
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

  pi.on("agent_settled", async (event, ctx) => {
    if (!planning || inherited || event.aborted || !ctx.hasUI || !/^#{1,3}\s*plan\b/im.test(planText)) return;
    const choice = await ctx.ui.select("The plan is ready.", ["Implement it", "Keep planning"]);
    if (choice !== "Implement it") return;
    apply(ctx, false);
    pi.appendEntry(ENTRY, { on: false });
    pi.sendUserMessage("Plan approved. Plan mode is off: implement the plan above, then verify it.");
  });
}
