/**
 * A live panel for running subagents, in the spirit of Claude Code's task view.
 *
 * `pi-lite-subagent` already ships `/view-subagents`, a list→detail browser over
 * the *finished* runs on the branch. What it does not give you is the thing you
 * actually watch during a fan-out: who is running right now, on what model, for
 * how long, and how it ended. This adds that as a widget above the editor, so it
 * is visible while the agents work rather than after they finish.
 *
 * It reads the `subagent` tool's own lifecycle updates rather than re-deriving
 * state, so there is one source of truth and nothing to keep in sync:
 *
 * - `tool_execution_start` opens a row per task.
 * - `tool_execution_update` carries the package's progress text
 *   ("Parallel: 2/4 done, 2 running...") and the per-task results as they land.
 * - `tool_execution_end` closes the block and leaves a summary behind, which
 *   clears itself on the next run so it does not become furniture.
 *
 * Toggle with /subagents. Off by default: a panel nobody asked for is one more
 * thing between you and your prompt.
 */

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
}

const firstLine = (text: string, max: number): string => {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const seconds = (ms: number): string => (ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`);

/** The task list from the tool's arguments, so rows appear before any output. */
export function rowsFromArgs(tasks: { agent?: string; task?: string }[] | undefined): TaskRow[] {
  if (!Array.isArray(tasks)) return [];
  const now = Date.now();
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
export function renderRows(rows: TaskRow[], now = Date.now()): string[] {
  if (rows.length === 0) return [];
  const running = rows.filter((r) => r.status === "running").length;
  const header = running > 0 ? `subagents  ${rows.length - running}/${rows.length} done` : `subagents  ${rows.length} done`;
  const lines = [header];
  for (const row of rows) {
    const icon = row.status === "ok" ? "+" : row.status === "failed" ? "x" : "·";
    const elapsed = seconds((row.endedAt ?? now) - row.startedAt);
    const model = row.model ? ` ${row.model}` : "";
    // The agent name is what you scan for; the task is the context.
    lines.push(`  ${icon} ${row.agent.padEnd(12)}${model.padEnd(0)} ${firstLine(row.task, 44)} (${elapsed})`);
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  let shown = false;
  let rows: TaskRow[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let ctxRef: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } } | undefined;

  const paint = () => {
    if (!shown || !ctxRef) return;
    ctxRef.ui.setWidget("subagents", renderRows(rows));
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
    // Do not hold the process open for a panel.
    (timer as { unref?: () => void }).unref?.();
  };

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    ctxRef = ctx as typeof ctxRef;
    const args = event.args as { tasks?: { agent?: string; task?: string }[] };
    rows = rowsFromArgs(args.tasks);
    if (rows.length === 0) return;
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
    paint();
    // Leave the finished summary up long enough to read, then clear it so the
    // panel does not sit there for the rest of the session.
    setTimeout(() => {
      if (rows.some((r) => r.status === "running")) return;
      rows = [];
      paint();
    }, 60_000).unref?.();
  });

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx as typeof ctxRef;
    shown = false;
    rows = [];
    stopTimer();
  });

  pi.registerCommand("subagents", {
    description: "Show or hide the live subagent panel",
    handler: async (_args, ctx) => {
      ctxRef = ctx as typeof ctxRef;
      shown = !shown;
      if (!shown) {
        stopTimer();
        ctx.ui.setWidget("subagents", undefined);
        ctx.ui.notify("Subagent panel hidden.", "info");
        return;
      }
      if (rows.length === 0) {
        ctx.ui.notify("Subagent panel shown; it fills in when a subagent runs.", "info");
        rows = [];
      }
      ctx.ui.setWidget("subagents", renderRows(rows));
    },
  });
}
