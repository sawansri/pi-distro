/**
 * /handoff [focus]: continue in a fresh session with a summary.
 *
 * Asks the model for a handoff note as a normal appended turn, so the server
 * reuses its cached prompt instead of re-reading the conversation under a
 * different prompt, then starts a new session whose first message is the note.
 * Cheaper than compaction when the next task only needs the gist.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const request = (focus: string) =>
  [
    "Write a handoff note so a fresh session can continue this work without the conversation.",
    focus ? `The next session will focus on: ${focus}` : "",
    "Include: the goal, what is done, decisions and their reasons, relevant files as path:line, commands that build or test, and the next steps. Under 400 words. Reply with only the note.",
  ]
    .filter(Boolean)
    .join("\n");

function lastAssistantText(entries: readonly unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : "")).join("");
    }
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  // Resolves when the run started by the handoff request is over. waitForIdle()
  // can return before a just-sent message has started its run.
  let onSettled: (() => void) | undefined;
  pi.on("agent_settled", () => {
    onSettled?.();
    onSettled = undefined;
  });

  pi.registerCommand("handoff", {
    description: "Summarize this session and continue in a fresh one",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish before handing off.", "warning");
        return;
      }
      const before = ctx.sessionManager.getBranch().length;
      const settled = new Promise<void>((resolve) => {
        onSettled = resolve;
      });
      pi.sendUserMessage(request(args.trim()));
      await settled;
      const note = lastAssistantText(ctx.sessionManager.getBranch().slice(before)).trim();
      if (!note) {
        ctx.ui.notify("The model didn't write a handoff note; staying in this session.", "error");
        return;
      }
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: `Handoff from the previous session:\n\n${note}` }],
            timestamp: Date.now(),
          });
        },
        withSession: async (next) => {
          next.ui.notify("Continuing in a new session from the handoff note.", "info");
        },
      });
    },
  });
}
