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

/**
 * The reply to the handoff request: the last assistant text after the request and
 * before any later user message (one typed while the note was being written).
 */
export function noteFrom(entries: readonly unknown[]): string {
  let note = "";
  let seenRequest = false;
  for (const entry of entries) {
    const e = entry as { type?: string; message?: { role?: string; content?: unknown; stopReason?: string } };
    if (e.type !== "message" || !e.message) continue;
    if (e.message.role === "user") {
      if (seenRequest) break;
      seenRequest = true;
      continue;
    }
    if (!seenRequest || e.message.role !== "assistant") continue;
    if (e.message.stopReason === "error" || e.message.stopReason === "aborted") return "";
    const content = e.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : "")).join("")
          : "";
    if (text.trim()) note = text;
  }
  return note;
}

export default function (pi: ExtensionAPI) {
  // Resolves when the run started by the handoff request is over. waitForIdle()
  // can return before a just-sent message has started its run.
  let onSettled: ((aborted: boolean) => void) | undefined;
  pi.on("agent_settled", (event) => {
    onSettled?.(event.aborted);
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
      const settled = new Promise<boolean>((resolve) => {
        onSettled = resolve;
      });
      pi.sendUserMessage(request(args.trim()));
      if (await settled) {
        ctx.ui.notify("Handoff stopped; staying in this session.", "warning");
        return;
      }
      const note = noteFrom(ctx.sessionManager.getBranch().slice(before)).trim();
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
