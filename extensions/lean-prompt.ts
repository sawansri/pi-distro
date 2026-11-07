/**
 * Lean system prompt for local models.
 *
 * Replaces pi's default preamble, tool list, rules, and pi-docs pointer with a
 * short prompt focused on behavior. Tool declarations already reach the model
 * with each request, so only guidance stays, and each line about a tool is
 * kept only while that tool is active. Project context, skills, and cwd are
 * unchanged.
 *
 * The prompt is built once per session and reused, so it stays byte-identical
 * for the server's prompt cache even if agent files change mid-session.
 *
 * Subagent children (pi-lite-subagent sets PI_SUBAGENT_DEPTH) get a shorter
 * prompt that is the same for every child, so parallel subagents share one
 * cached prefix. pi-lite-subagent appends the agent's own instructions after it.
 *
 * Adapted from lemonade-pi's lean-prompt.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

type Line = string | [tool: string, text: string];

const MAIN: Line[] = [
  "You are a coding agent working in the user's terminal and repository. Use your tools to act; never guess about code you haven't read.",
  "",
  "# Working",
  "- Read code before changing it. Make focused changes that match the surrounding style; don't add unrequested features, comments, or refactors.",
  "- For non-trivial or ambiguous tasks, investigate first and plan before editing.",
  "- When a decision is the user's to make, ask instead of guessing.",
  ["todo", "- Track work with 3 or more steps with the todo tool; keep exactly one item in progress."],
  ["subagent", "- Delegate broad searches and independent subtasks to subagents to keep your context small; run independent ones in parallel."],
  ["web_search", "- Search the web for current information or unfamiliar APIs, read the best sources with web_extract, and cite the URLs you used. For in-depth research, load the pi-deep-research skill."],
  "- After changes, verify with tests, a build, or a typecheck. Report failures honestly, with the output.",
  "- Confirm before destructive or irreversible actions such as deleting files, force-pushing, or dropping data.",
  "",
  "# Communication",
  "- Be concise and direct. Lead with the answer; no preamble or recap.",
  "- Reference code as path:line.",
];

const CHILD: Line[] = [
  "You are a subagent: another agent delegated one task to you. Work autonomously with your tools; you cannot ask questions. Never guess about code you haven't read.",
  "Your final message is all the delegating agent sees, so make it a complete, concise report. Reference code as path:line.",
];

/** `- name: description` for each user agent. */
function agentRoster(): string {
  const dir = path.join(getAgentDir(), "agents");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const file of files.sort()) {
    try {
      const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(
        fs.readFileSync(path.join(dir, file), "utf-8"),
      );
      if (typeof frontmatter.name === "string" && typeof frontmatter.description === "string") {
        lines.push(`- ${frontmatter.name}: ${frontmatter.description}`);
      }
    } catch {
      // A malformed agent file is skipped, as pi-lite-subagent does.
    }
  }
  return lines.length > 0 ? `\n\n# Subagents\n${lines.join("\n")}` : "";
}

function render(lines: Line[], tools: string[]): string {
  return lines
    .filter((line) => typeof line === "string" || tools.includes(line[0]))
    .map((line) => (typeof line === "string" ? line : line[1]))
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const isChild = Boolean(process.env.PI_SUBAGENT_DEPTH);
  let prompt: string | undefined;

  pi.on("session_start", () => {
    prompt = undefined;
  });

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    // A user-supplied --system-prompt or SYSTEM.md wins.
    if (options.customPrompt) return;
    if (prompt === undefined) {
      const tools = options.selectedTools.filter((name) => !options.hiddenTools.includes(name));
      prompt = render(isChild ? CHILD : MAIN, tools);
      if (!isChild && tools.includes("subagent")) prompt += agentRoster();
    }
    options.customPrompt = prompt;
  });
}
