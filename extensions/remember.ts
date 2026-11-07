/**
 * /remember: notes that carry over to future sessions.
 *
 * `/remember <note>` saves a note for the current project; `/remember -g <note>`
 * saves it for every project; `/remember` alone lists both. Notes live in the
 * agent directory (notes.md, and notes/<project>.md keyed by the working
 * directory), never in the repository.
 *
 * Notes are read once when a session starts and put in the system prompt's
 * <notes> section, which then stays fixed for the session's prompt cache. A
 * note saved mid-session reaches the model as an appended message instead.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const globalFile = () => path.join(getAgentDir(), "notes.md");
const projectFile = (cwd: string) =>
  path.join(getAgentDir(), "notes", `${createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12)}.md`);

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

/** Notes without the header line that names the project directory. */
const body = (text: string) => text.replace(/^<!--.*?-->\n?/, "").trim();

function save(file: string, note: string, header?: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = !fs.existsSync(file) && header ? `${header}\n` : "";
  fs.appendFileSync(file, `${prefix}- ${note.replace(/\s*\n\s*/g, " ")}\n`);
}

export function render(globalNotes: string, projectNotes: string): string {
  const parts = [
    globalNotes && `General:\n${globalNotes}`,
    projectNotes && `This project:\n${projectNotes}`,
  ].filter(Boolean);
  return parts.length > 0 ? `Notes the user asked you to remember:\n${parts.join("\n\n")}` : "";
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_DEPTH) return;
  let frozen: string | undefined;

  pi.on("session_start", () => {
    frozen = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    frozen ??= render(body(read(globalFile())), body(read(projectFile(ctx.cwd))));
    if (frozen) event.systemPromptOptions.sections.notes = frozen;
  });

  pi.registerCommand("remember", {
    description: "Save a note for future sessions (-g: all projects); no argument lists notes",
    handler: async (args, ctx) => {
      let note = args.trim();
      if (!note) {
        const text = render(body(read(globalFile())), body(read(projectFile(ctx.cwd))));
        ctx.ui.notify(text || "No notes yet. Add one with /remember <note>.", "info");
        return;
      }
      const isGlobal = /^(-g|--global)\s+/.test(note);
      note = note.replace(/^(-g|--global)\s+/, "");
      if (isGlobal) save(globalFile(), note);
      else save(projectFile(ctx.cwd), note, `<!-- ${path.resolve(ctx.cwd)} -->`);
      pi.sendMessage(
        { customType: "pi-distro-note", content: `The user asked you to remember: ${note}`, display: true },
        { triggerTurn: false },
      );
      ctx.ui.notify(`Saved for ${isGlobal ? "all projects" : "this project"}.`, "info");
    },
  });
}
