/**
 * A live panel for running subagents, in the spirit of Claude Code's task view.
 *
 * Two things it adds over `pi-lite-subagent`'s own `/view-subagents`, which
 * browses finished runs:
 *
 * - It is always visible while agents work: who is running, on what model, for
 *   how long, and how it ended.
 * - Each row opens that subagent's session, so a fan-out can be inspected one
 *   child at a time instead of through a summary.
 *
 * The panel reads the subagent tool's own lifecycle events rather than
 * re-deriving state, so there is one source of truth and nothing to keep in
 * sync. Opening a row resolves the child session file from the directory the
 * package writes to (`<sessionDir>/lite-subagent/<sessionId>/`), which exists
 * from the moment the child starts — so a running agent can be inspected too.
 *
 * Interactions, because regular (non-fullscreen) mode leaves mouse input to the
 * terminal while fullscreen routes it here:
 *
 * - click a row (fullscreen) — open that subagent
 * - /subagents open <n> — open the nth row; works everywhere
 * - /subagents — show or hide
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One dispatched task, as the widget shows it. */
export interface TaskRow {
  agent: string;
  task: string;
  /** Set once the package reports the task's result. */
  status?: "ok" | "failed" | "running";
  model?: string;
  startedAt: number;
  endedAt?: number;
  /** Directory holding this child's session file, once resolved. */
  sessionDir?: string;
}

const firstLine = (text: string, max: number): string => {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const seconds = (ms: number): string => (ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`);

/** The task list from the tool's arguments, so rows appear before any output. */
export function rowsFromArgs(tasks: { agent?: string; task?: string }[] | undefined, now = Date.now()): TaskRow[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task) => ({
    agent: String(task?.agent ?? "?"),
    task: String(task?.task ?? ""),
    status: "running" as const,
    startedAt: now,
  }));
}

/** Fold one progress update into the rows, matching finished results by agent+task. */
export function applyResults(rows: TaskRow[], results: any[], now = Date.now()): TaskRow[] {
  if (!Array.isArray(results)) return rows;
  return rows.map((row) => {
    const match = results.find((r) => r?.agent === row.agent && String(r?.task ?? "").trim() === row.task.trim());
    if (!match) return row;
    const done = match.exitCode !== undefined;
    return {
      ...row,
      status: done ? (match.exitCode === 0 ? "ok" : "failed") : "running",
      model: typeof match.model === "string" ? match.model : row.model,
      endedAt: done ? (row.endedAt ?? now) : undefined,
    };
  });
}

/** The panel's lines. Kept pure so the layout is testable without a terminal. */
export function renderRows(rows: TaskRow[], now = Date.now(), selected = -1): string[] {
  if (rows.length === 0) return [];
  const running = rows.filter((r) => r.status === "running").length;
  const header = running > 0 ? `subagents  ${rows.length - running}/${rows.length} done` : `subagents  ${rows.length} done`;
  const lines = [header];
  // Fixed columns so the eye can scan one field at a time: the agent, then the
  // model, then the task. Padding the model only when present ragged the rows.
  const agentWidth = Math.max(...rows.map((r) => r.agent.length), 6);
  const modelWidth = Math.max(...rows.map((r) => (r.model ?? "").length), 0);
  rows.forEach((row, index) => {
    const icon = row.status === "ok" ? "+" : row.status === "failed" ? "x" : "·";
    const elapsed = seconds((row.endedAt ?? now) - row.startedAt);
    const model = modelWidth > 0 ? `${(row.model ?? "").padEnd(modelWidth)} ` : "";
    const marker = index === selected ? ">" : " ";
    lines.push(`${marker} ${icon} ${row.agent.padEnd(agentWidth)}  ${model}${firstLine(row.task, 44)} (${elapsed})`);
  });
  return lines;
}

/**
 * Whether the panel should be on screen.
 *
 * `auto` is the default: the panel exists only while a fan-out is in flight, so
 * a session with no subagents has nothing between the transcript and the prompt.
 * `pinned` is what /subagents asks for, and survives the run ending.
 */
export function panelVisible(mode: "auto" | "pinned" | "off", running: boolean): boolean {
  if (mode === "off") return false;
  if (mode === "pinned") return true;
  return running;
}

/**
 * The row a click at `y` lands on, or -1.
 *
 * Line 0 is the header, so row `i` is drawn at `y === i + 1`. Returns -1 for the
 * header and for a click past the last row, so a stray click does nothing.
 */
export function rowAtLine(y: number, count: number): number {
  const index = y - 1;
  return index >= 0 && index < count ? index : -1;
}

/**
 * The newest session file in a child's session directory, or undefined.
 *
 * The directory is created when the child starts and the file is appended as it
 * runs, so this resolves for a running subagent as well as a finished one.
 */
export function newestSessionFile(dir: string): string | undefined {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const file = path.join(dir, name);
        try {
          return { file, at: fs.statSync(file).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is { file: string; at: number } => entry !== undefined)
      .sort((a, b) => b.at - a.at);
    return files[0]?.file;
  } catch {
    return undefined;
  }
}

/** The child session directory the package uses for one parent session. */
export const childSessionDir = (sessionDir: string, sessionId: string): string =>
  path.join(sessionDir, "lite-subagent", sessionId);

export default function (pi: ExtensionAPI) {
  /**
   * Whether the panel is on screen.
   *
   * - `auto`: not drawn until a fan-out starts, and taken away when it ends, so
   *   it is never furniture in a session with no subagents.
   * - `pinned`: the user asked for it with /subagents, so it survives the run.
   * - `off`: the user hid it with /subagents.
   */
  let mode: "auto" | "pinned" | "off" = "auto";
  let rows: TaskRow[] = [];
  let selected = -1;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ctxRef: any;
  /** True between a tool_execution_start and its end for the subagent tool. */
  let running = false;

  const visible = () => panelVisible(mode, running);

  /** Open one row's child session, if it can be resolved and the agent is idle. */
  const openRow = async (index: number, ctx: any) => {
    const row = rows[index];
    if (!row) return;
    const dir = row.sessionDir ?? childSessionDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
    const file = newestSessionFile(dir);
    if (!file) {
      ctx.ui.notify(`No session found yet for ${row.agent}.`, "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current run to finish before opening a subagent session.", "warning");
      return;
    }
    const result = await ctx.switchSession(file);
    if (result?.cancelled) ctx.ui.notify("Stayed in this session.", "info");
  };

  /**
   * Draw the panel, and accept clicks on it.
   *
   * The widget is a component rather than a string array because only a
   * component receives mouse events. Fullscreen mode routes clicks here; in
   * regular mode the terminal keeps them, which is why `/subagents open <n>`
   * exists as the keyboard path.
   */
  const paint = () => {
    if (!ctxRef) return;
    if (!visible() || rows.length === 0) {
      ctxRef.ui.setWidget("subagents", undefined);
      return;
    }
    ctxRef.ui.setWidget("subagents", () => ({
      render: () => renderRows(rows, Date.now(), selected),
      // `y` is local to this component, so line 1 of the render is row 0.
      handleMouse: (event: any) => {
        if (event?.type !== "click" || event.button !== "left") return undefined;
        const index = rowAtLine(event.y, rows.length);
        if (index === -1) return undefined;
        selected = index;
        paint();
        void openRow(index, ctxRef);
        return { handled: true };
      },
      invalidate: () => {},
    }));
  };

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const startTimer = () => {
    stopTimer();
    // Elapsed time is the only thing that changes between updates, so a slow
    // tick is enough and keeps redraws cheap.
    timer = setInterval(paint, 1000);
    (timer as { unref?: () => void }).unref?.();
  };

  /** Resolve each row's child session directory, so a click has somewhere to go. */
  const resolveSessions = (ctx: any) => {
    const dir = childSessionDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
    rows = rows.map((row) => ({ ...row, sessionDir: row.sessionDir ?? dir }));
  };

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    ctxRef = ctx;
    const args = event.args as { tasks?: { agent?: string; task?: string }[] };
    rows = rowsFromArgs(args.tasks);
    selected = -1;
    if (rows.length === 0) return;
    running = true;
    resolveSessions(ctx);
    paint();
    startTimer();
  });

  pi.on("tool_execution_update", (event) => {
    if (event.toolName !== "subagent") return;
    const details = (event.partialResult as { details?: { results?: any[] } } | undefined)?.details;
    if (!details?.results) return;
    rows = applyResults(rows, details.results);
    paint();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "subagent") return;
    const details = (event.result as { details?: { results?: any[] } } | undefined)?.details;
    if (details?.results) rows = applyResults(rows, details.results);
    stopTimer();
    running = false;
    // The run is over: in auto mode the panel goes away with it, which is the
    // point — nothing on screen that reports on nothing.
    if (mode === "auto") {
      rows = [];
      selected = -1;
    }
    paint();
  });

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    rows = [];
    selected = -1;
    stopTimer();
    running = false;
    paint();
  });

  pi.registerCommand("subagents", {
    description: "Show or hide the subagent panel; /subagents open <n> inspects one",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (words[0] === "open") {
        const n = Number(words[1]);
        if (!Number.isInteger(n) || n < 1 || n > rows.length) {
          ctx.ui.notify(`Pick a row between 1 and ${rows.length}.`, "warning");
          return;
        }
        selected = n - 1;
        paint();
        await openRow(n - 1, ctx);
        return;
      }
      // From auto, the first /subagents pins the panel so it stops disappearing
      // between runs; from pinned or off it hides.
      if (mode === "pinned") {
        mode = "off";
        ctx.ui.setWidget("subagents", undefined);
        ctx.ui.notify("Subagent panel hidden. /subagents shows it again.", "info");
        return;
      }
      mode = "pinned";
      if (rows.length === 0) {
        ctx.ui.notify("Subagent panel pinned; it fills in when a subagent runs.", "info");
        return;
      }
      paint();
      ctx.ui.notify("Subagent panel pinned.", "info");
    },
  });
}
