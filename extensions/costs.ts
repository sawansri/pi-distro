/**
 * /costs: what this session has actually spent, and where.
 *
 * On a hosted gateway the cost is the constraint, and pi's footer shows only a
 * running total. This breaks it down the two ways that change a decision: by
 * model (is the expensive one earning its place?) and by subagent call (did that
 * fan-out pay for itself?).
 *
 * Almost none of this is computed here. Subagent results already carry per-task
 * `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `contextTokens` and
 * `turns` (the subagent runner's details); assistant messages carry usage
 * and cost; the session branch carries both. So the command reads session state
 * and adds it up, which is why it needs no bookkeeping of its own and works on
 * an old session as well as a live one.
 *
 * The one thing worth watching is not the total but the **cache-read share**: a
 * cheap model with no cache is often dearer than an expensive one that is
 * cached, and that is invisible in a single number.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Spend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Model calls that reported usage. */
  calls: number;
}

/** A subagent task, as the subagent runner records it. */
export interface SubagentSpend extends Spend {
  agent: string;
  task: string;
  model?: string;
  turns?: number;
  contextTokens?: number;
  status: string;
}

export const emptySpend = (): Spend => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function add(into: Spend, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  into.input += num(usage.input);
  into.output += num(usage.output);
  into.cacheRead += num(usage.cacheRead);
  into.cacheWrite += num(usage.cacheWrite);
  // Cost arrives either normalised (`cost.total`) or as a bare number.
  into.cost += num(usage.cost?.total ?? usage.cost);
  into.calls += 1;
}

/** Prompt tokens, counting cache reads and writes as the same prompt seen again. */
export const promptTokens = (s: Spend): number => s.input + s.cacheRead + s.cacheWrite;

/** Share of the prompt served from cache, 0..1. Undefined when nothing was billed. */
export function cacheShare(s: Spend): number | undefined {
  const prompt = promptTokens(s);
  return prompt > 0 ? s.cacheRead / prompt : undefined;
}

/** Per-model spend from a session branch: assistant messages and usage entries. */
export function spendByModel(entries: readonly any[]): Map<string, Spend> {
  const byModel = new Map<string, Spend>();
  for (const entry of entries) {
    let key: string | undefined;
    let usage: any;
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message;
      key = `${message.provider}/${message.responseModel ?? message.model}`;
      usage = message.usage;
    } else if (entry?.type === "usage") {
      key = `${entry.provider}/${entry.model}`;
      usage = entry.usage;
    }
    if (!key || !usage) continue;
    const bucket = byModel.get(key) ?? emptySpend();
    add(bucket, usage);
    byModel.set(key, bucket);
  }
  return byModel;
}

/** The subagent tasks a branch records, from each `subagent` tool result's details. */
export function spendBySubagent(entries: readonly any[]): SubagentSpend[] {
  const out: SubagentSpend[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
    const message = entry.message;
    const details = message.details ?? {};

    // An array of per-task results: the older array-shaped runner.
    if (Array.isArray(details.results)) {
      for (const result of details.results) {
        const usage = result?.usage;
        const spend = emptySpend();
        add(spend, usage);
        out.push({
          ...spend,
          agent: String(result?.agent ?? "?"),
          task: String(result?.task ?? ""),
          model: result?.model,
          turns: typeof usage?.turns === "number" ? usage.turns : undefined,
          contextTokens: typeof usage?.contextTokens === "number" ? usage.contextTokens : undefined,
          status: result?.exitCode === undefined ? "running" : result.exitCode === 0 ? "ok" : "failed",
        });
      }
      continue;
    }

    // One agent per call: usage rides on the tool result itself, where pi also
    // aggregates it into the session totals. The details carry the descriptive
    // fields and a formatted token string, not numeric usage.
    if (typeof details.subagentType === "string" || typeof details.displayName === "string") {
      const spend = emptySpend();
      add(spend, message.usage);
      // The runner reports its own numeric cost, which is the figure it priced;
      // prefer it over anything derived here. `tokens` is a display string
      // ("4.8k"), so it is not parsed back into a number.
      if (typeof details.cost === "number" && Number.isFinite(details.cost)) {
        spend.cost = details.cost;
        if (spend.calls === 0) spend.calls = 1;
      }
      const status = String(details.status ?? "");
      out.push({
        ...spend,
        agent: String(details.subagentType ?? details.displayName ?? "?"),
        task: String(details.description ?? ""),
        model: typeof details.modelName === "string" ? details.modelName : undefined,
        turns: typeof details.toolUses === "number" ? details.toolUses : undefined,
        // `tokens` is formatted for display ("4.8k"); keep it out of the numeric
        // column rather than parsing a human string back into a number.
        status: status === "completed" ? "ok" : status === "running" || status === "queued" ? "running" : "failed",
      });
    }
  }
  return out;
}

const money = (value: number): string => {
  if (!Number.isFinite(value)) return "$0.0000";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(value < 1 ? 4 : 2)}`;
};

const tokens = (value: number): string => {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

const cacheLabel = (share: number | undefined): string =>
  share === undefined ? "-" : `${Math.round(share * 100)}%`;

/** One aligned row, so columns line up in a monospace terminal. */
function row(cells: [string, string, string, string, string, string]): string {
  const [model, cost, prompt, out, calls, cache] = cells;
  return `${model.padEnd(28)} ${cost.padStart(10)} ${prompt.padStart(8)} ${out.padStart(7)} ${calls.padStart(5)} ${cache.padStart(6)}`;
}

/**
 * The report, as plain lines: pi renders these in the transcript or a widget,
 * and they stay readable when copied out of a terminal.
 */
export function renderReport(branch: readonly any[]): string[] {
  const byModel = spendByModel(branch);
  const subs = spendBySubagent(branch);
  const lines: string[] = [];

  const models = [...byModel].sort((a, b) => b[1].cost - a[1].cost);
  const total = emptySpend();
  for (const [, spend] of models) {
    total.input += spend.input;
    total.output += spend.output;
    total.cacheRead += spend.cacheRead;
    total.cacheWrite += spend.cacheWrite;
    total.cost += spend.cost;
    total.calls += spend.calls;
  }

  if (models.length === 0 && subs.length === 0) {
    return ["No usage recorded in this session yet."];
  }

  lines.push(row(["model", "cost", "prompt", "out", "calls", "cache"]));
  for (const [name, spend] of models) {
    lines.push(
      row([
        name.length > 28 ? `${name.slice(0, 27)}…` : name,
        money(spend.cost),
        tokens(promptTokens(spend)),
        tokens(spend.output),
        String(spend.calls),
        cacheLabel(cacheShare(spend)),
      ]),
    );
  }
  lines.push(row(["total", money(total.cost), tokens(promptTokens(total)), tokens(total.output), String(total.calls), "-"]));

  if (subs.length > 0) {
    // The subagent's own tokens are already inside the model rows above, since
    // its process reports usage into the parent's session. This section answers
    // a different question: was the fan-out worth it, per call?
    const subTotal = subs.reduce((sum, s) => sum + s.cost, 0);
    const subTokens = subs.reduce((sum, s) => sum + s.input + s.output + s.cacheRead + s.cacheWrite, 0);
    lines.push("");
    lines.push(row(["subagent", "cost", "tokens", "turns", "ctx", "status"]));
    for (const sub of subs) {
      const label = `${sub.agent}${sub.model ? ` (${sub.model})` : ""}`;
      lines.push(
        row([
          label.length > 28 ? `${label.slice(0, 27)}…` : label,
          money(sub.cost),
          tokens(sub.input + sub.output + sub.cacheRead + sub.cacheWrite),
          sub.turns === undefined ? "-" : String(sub.turns),
          sub.contextTokens === undefined ? "-" : tokens(sub.contextTokens),
          sub.status,
        ]),
      );
    }
    lines.push(row([`${subs.length} call(s)`, money(subTotal), tokens(subTokens), "", "", ""]));
  }

  if (total.cacheRead > 0) {
    // What the cache saved, priced at each model's own input rate where known.
    // A rough figure is still the right order of magnitude for a decision.
    lines.push("");
    lines.push(`cache served ${tokens(total.cacheRead)} prompt tokens; ${cacheLabel(cacheShare(total))} of all prompted tokens were reads`);
  }

  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("costs", {
    description: "Spend by model and by subagent call for this session",
    handler: async (_args, ctx) => {
      const lines = renderReport(ctx.sessionManager.getBranch());
      // A widget sits above the editor and survives the next turn; notify does
      // not, and in print mode there is no UI at all.
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("costs", lines);
        ctx.ui.notify("Costs shown above the editor; run /costs again to refresh.", "info");
        return;
      }
      for (const line of lines) console.log(line);
    },
  });
}
