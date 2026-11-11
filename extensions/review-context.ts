/**
 * Hands the `reviewer` agent the diff it is supposed to review.
 *
 * `agents/reviewer.md` tells the model to "use bash to inspect (git diff/log/show)",
 * which means every review starts by rediscovering which changes are under
 * consideration. In practice that goes wrong in two ways: it re-derives context
 * the session already had, and it guesses a base (`HEAD~1`? `main`? the merge
 * base?) and silently reviews the wrong range.
 *
 * So when a `subagent` call dispatches the reviewer, this appends the actual
 * change set to its task. Three sources, best first:
 *
 * 1. The session's own record of what it changed, taken from the `edit` and
 *    `write` tool calls in this branch, rendered as a patch. This is exactly
 *    "what the agent just did", with no base-branch guessing.
 * 2. A diff against the base branch, when the repo is clean enough to have one.
 * 3. Nothing, in which case the reviewer falls back to its instructions and
 *    behaves as before.
 *
 * The diff is capped: a reviewer that receives a 40k-line patch spends its whole
 * context on it, and truncation with a note is cheaper than a silent skip.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Ran patches beyond this are cut; the reviewer can read the files for the rest. */
const MAX_DIFF_CHARS = 60_000;

export interface ChangedFile {
  path: string;
  /** The tool that touched it, for the summary line. */
  tool: string;
}

/**
 * Files this branch's `edit`/`write` calls touched, newest last.
 *
 * Read from the transcript rather than from git, so it covers untracked files and
 * never depends on a base ref existing.
 */
export function filesChangedInSession(branch: readonly any[]): ChangedFile[] {
  const seen = new Map<string, ChangedFile>();
  for (const entry of branch) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      const tool = String(block.name ?? "");
      if (tool !== "edit" && tool !== "write") continue;
      const path = block.arguments?.path;
      if (typeof path !== "string" || path === "") continue;
      seen.set(path, { path, tool });
    }
  }
  return [...seen.values()];
}

/** `git diff` against whatever base is configured, or an empty string. */
function repoDiff(cwd: string): string {
  const run = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  // Prefer the merge-base with the default branch: `git diff main` includes
  // changes that were already on main, which makes a review noisy and wrong.
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    const mergeBase = run(["merge-base", "HEAD", base]).trim();
    if (mergeBase) return run(["diff", "--no-color", mergeBase]);
  }
  return run(["diff", "--no-color", "HEAD"]);
}

/**
 * A patch for files git is not tracking yet, since `git diff` does not show them
 * and a new file is often the whole change. Bounded to the first few files.
 */
function untrackedDiff(cwd: string): string {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const listed = git(["ls-files", "--others", "--exclude-standard"]);
  if (listed.status !== 0) return "";
  const files = (listed.stdout ?? "").split("\n").filter(Boolean).slice(0, 10);
  const out: string[] = [];
  for (const file of files) {
    // `diff --no-index` exits 1 when the files differ, which is the normal case,
    // so the output is read rather than the exit status.
    const result = git(["diff", "--no-color", "--no-index", "--", "/dev/null", file]);
    if (result.stdout) out.push(result.stdout);
  }
  return out.join("");
}

/**
 * The change set to hand a reviewer: the branch's edited files, then a real
 * patch where one is available. Empty when neither source yields anything.
 */
export function reviewContext(branch: readonly any[], cwd: string): string {
  const changed = filesChangedInSession(branch);
  const parts: string[] = [];
  if (changed.length > 0) {
    parts.push(`Files this session changed:\n${changed.map((f) => `- ${f.path}`).join("\n")}`);
  }
  const patch = repoDiff(cwd) || untrackedDiff(cwd);
  if (patch.trim()) {
    const cut = patch.length > MAX_DIFF_CHARS;
    parts.push(
      `Diff under review:\n\`\`\`diff\n${cut ? `${patch.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated at ${MAX_DIFF_CHARS} characters; read the files for the rest]` : patch}\n\`\`\``,
    );
  }
  return parts.join("\n\n");
}

/** The task text sent to a reviewer, with the change set appended. */
export function withReviewContext(task: string, context: string): string {
  if (!context) return task;
  return `${task}\n\n---\n${context}\n\nReview this change set. Cite \`path:line\` from it rather than guessing at a range.`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as { tasks?: { agent?: string; task?: string }[] };
    if (!Array.isArray(input.tasks)) return;
    // Only the reviewer needs a diff; an explore agent asked to find something
    // should not pay for one.
    const reviews = input.tasks.filter((t) => /review/i.test(String(t?.agent ?? "")));
    if (reviews.length === 0) return;
    const context = reviewContext(ctx.sessionManager.getBranch(), ctx.cwd);
    if (!context) return;
    // Mutating input in place is how a tool_call handler patches arguments; the
    // execution that follows sees the change.
    for (const task of input.tasks) {
      if (!/review/i.test(String(task?.agent ?? ""))) continue;
      task.task = withReviewContext(String(task.task ?? ""), context);
    }
  });
}
