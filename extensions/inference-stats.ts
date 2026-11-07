/**
 * Inference stats in the footer, measured by the inference server itself.
 *
 * After each response the footer shows that request's prefill (tokens and
 * tokens/s), decode (tokens and tokens/s), time to first token, and draft
 * acceptance when speculative decoding ran. These come from gufo's per-request
 * `usage.gufo` measurements (or llama-server's `timings`), so they cover exactly
 * one request, unlike server-wide gauges that mix in subagents and other clients.
 *
 * While a response streams, the footer shows its live progress from the
 * server's `/slots`, sampled every second: prompt tokens prefilled so far, then
 * tokens decoded and the decode rate. The rate runs from the first sample
 * taken mid-decode to the latest, so idle time never dilutes it and whole-token
 * steps average out. (Prometheus
 * token counters advance per 512-token prefill chunk and include every client,
 * so they aren't used for per-request rates.) The server part shows busy and
 * queued sessions and KV-cache use from Prometheus `/metrics`.
 *
 * `/stats` shows the last request in full and this session's totals.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 1000;

export interface RequestStats {
  /** Prompt tokens processed by this request (not restored from cache). */
  prefillTokens: number;
  prefillMs?: number;
  cachedTokens: number;
  decodeTokens: number;
  decodeMs?: number;
  ttftMs?: number;
  queueMs?: number;
  draftTokens?: number;
  draftAccepted?: number;
}

/** Reads one request's stats from a gufo usage object or llama-server timings. */
export function requestStats(usage: any, timings?: any): RequestStats | undefined {
  const gufo = usage?.gufo;
  if (gufo && typeof gufo.decode_ms === "number") {
    return {
      prefillTokens: gufo.prefill_tokens ?? 0,
      prefillMs: gufo.prefill_ms,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
      decodeTokens: usage.completion_tokens ?? 0,
      decodeMs: gufo.decode_ms,
      ttftMs: gufo.ttft_ms,
      queueMs: gufo.queue_ms,
      draftTokens: usage.draft_tokens,
      draftAccepted: usage.draft_tokens_accepted,
    };
  }
  if (timings && typeof timings.predicted_ms === "number") {
    return {
      prefillTokens: timings.prompt_n ?? 0,
      prefillMs: timings.prompt_ms,
      cachedTokens: timings.cache_n ?? 0,
      decodeTokens: timings.predicted_n ?? 0,
      decodeMs: timings.predicted_ms,
      ttftMs: timings.prompt_ms,
      draftTokens: timings.draft_n,
      draftAccepted: timings.draft_n_accepted,
    };
  }
  return undefined;
}

export interface SlotSample {
  task: number;
  at: number;
  promptTokens: number;
  cachedTokens: number;
  processedTokens: number;
  decoded: number;
}

/** Busy slots from a llama-server-style /slots response. */
export function busySlots(slots: unknown, at: number): SlotSample[] {
  if (!Array.isArray(slots)) return [];
  return slots
    .filter((slot) => typeof slot?.id_task === "number" && slot.id_task !== -1)
    .map((slot) => ({
      task: slot.id_task,
      at,
      promptTokens: slot.n_prompt_tokens ?? 0,
      cachedTokens: slot.n_prompt_tokens_cache ?? 0,
      processedTokens: slot.n_prompt_tokens_processed ?? 0,
      decoded: slot.next_token?.[0]?.n_decoded ?? 0,
    }));
}

/** "prefill 1.2k/3.0k", or "decode 45 @ 71.2 t/s", the rate measured from `since`, an earlier mid-decode sample. */
export function liveLine(current: SlotSample, since?: SlotSample): string {
  const uncached = current.promptTokens - current.cachedTokens;
  if (current.decoded === 0 && current.processedTokens < uncached) {
    return `prefill ${count(current.processedTokens)}/${count(uncached)}`;
  }
  const midDecode = since && since.task === current.task && since.decoded > 0 && current.at > since.at;
  const tg = midDecode ? ((current.decoded - since!.decoded) * 1000) / (current.at - since!.at) : undefined;
  return `decode ${count(current.decoded)}${tg !== undefined ? ` @ ${compact(tg)} t/s` : ""}`;
}

/** Parses Prometheus text format into metric name → value (unlabelled samples only). */
export function parsePrometheus(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\S+)/);
    if (match) metrics.set(match[1], Number(match[2]));
  }
  return metrics;
}

const rate = (tokens: number, ms?: number) => (ms && ms > 0 ? (tokens * 1000) / ms : undefined);

export function compact(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1);
}

/** A token count: whole below 1,000, then compact. */
export const count = (n: number) => (n < 1000 ? String(Math.round(n)) : compact(n));

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** One footer line: "pp 3.2k @ 1.8k t/s · tg 412 @ 71.2 t/s · ttft 1.9s · draft 78%". */
export function formatRequest(s: RequestStats): string {
  const parts: string[] = [];
  const pp = rate(s.prefillTokens, s.prefillMs);
  parts.push(s.prefillTokens > 0 && pp !== undefined ? `pp ${count(s.prefillTokens)} @ ${compact(pp)} t/s` : "pp cached");
  const tg = rate(s.decodeTokens, s.decodeMs);
  if (tg !== undefined) parts.push(`tg ${count(s.decodeTokens)} @ ${compact(tg)} t/s`);
  if (s.ttftMs !== undefined) parts.push(`ttft ${seconds(s.ttftMs)}`);
  if (s.draftTokens) parts.push(`draft ${Math.round((100 * (s.draftAccepted ?? 0)) / s.draftTokens)}%`);
  return parts.join(" · ");
}

interface Totals {
  requests: number;
  prefillTokens: number;
  prefillMs: number;
  cachedTokens: number;
  decodeTokens: number;
  decodeMs: number;
  ttftMs: number;
}

const emptyTotals = (): Totals => ({ requests: 0, prefillTokens: 0, prefillMs: 0, cachedTokens: 0, decodeTokens: 0, decodeMs: 0, ttftMs: 0 });

export default function (pi: ExtensionAPI) {
  let serverUrl: string | undefined;
  let slots: number | undefined;
  let last: RequestStats | undefined;
  let lastLine = "";
  let usage: unknown;
  let timings: unknown;
  let totals = emptyTotals();
  let poll: ReturnType<typeof setInterval> | undefined;
  /** The first sample of this request taken mid-decode. */
  let decodeStart: SlotSample | undefined;
  /** Tasks already running when this request was sent, which belong to other clients. */
  let foreign: Set<number> | undefined;

  async function metrics(): Promise<Map<string, number> | undefined> {
    if (!serverUrl) return undefined;
    try {
      const response = await fetch(`${serverUrl}/metrics`, { signal: AbortSignal.timeout(1000) });
      return response.ok ? parsePrometheus(await response.text()) : undefined;
    } catch {
      return undefined;
    }
  }

  function server(m: Map<string, number> | undefined): string {
    if (!m) return "";
    const busy = m.get("llamacpp:requests_processing") ?? 0;
    const queued = m.get("llamacpp:requests_deferred") ?? 0;
    const kv = m.get("llamacpp:kv_cache_usage_ratio");
    const parts = [`srv ${busy}${slots ? `/${slots}` : ""} busy`];
    if (queued > 0) parts.push(`${queued} queued`);
    if (kv !== undefined) parts.push(`kv ${Math.round(kv * 100)}%`);
    return parts.join(", ");
  }

  function show(ctx: ExtensionContext, text: string) {
    ctx.ui.setStatus("inference", text || undefined);
  }

  /** Live progress of this request from /slots, with server state from /metrics. */
  async function sample(ctx: ExtensionContext) {
    let busy: SlotSample[] = [];
    try {
      const response = await fetch(`${serverUrl}/slots`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) busy = busySlots(await response.json(), Date.now());
    } catch {
      // No /slots: show the last request's stats only.
    }
    // This request's slot: the newest task that wasn't already running when it was sent.
    if (foreign === undefined) foreign = new Set(busy.map((slot) => slot.task));
    const mine = busy.filter((slot) => !foreign!.has(slot.task)).sort((a, b) => b.task - a.task)[0];
    const live = mine ? liveLine(mine, decodeStart) : "";
    if (mine && mine.decoded > 0 && decodeStart?.task !== mine.task) decodeStart = mine;
    show(ctx, [live || lastLine, server(await metrics())].filter(Boolean).join(" | "));
  }

  function stopPolling() {
    if (poll) clearInterval(poll);
    poll = undefined;
    decodeStart = undefined;
    foreign = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    stopPolling();
    totals = emptyTotals();
    last = undefined;
    lastLine = "";
    if (!ctx.hasUI) return;
    const baseUrl = (ctx.model as { baseUrl?: string } | undefined)?.baseUrl;
    serverUrl = baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, "");
    slots = undefined;
    if (!serverUrl) return;
    try {
      const props = await (await fetch(`${serverUrl}/props`, { signal: AbortSignal.timeout(1000) })).json();
      if (typeof props?.total_slots === "number") slots = props.total_slots;
    } catch {
      // Not a llama-server-compatible server: no slot count.
    }
  });

  pi.on("model_select", (event) => {
    serverUrl = (event.model as { baseUrl?: string }).baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, "");
  });

  pi.on("before_provider_request", (_event, ctx) => {
    usage = timings = undefined;
    if (!ctx.hasUI || !serverUrl) return;
    stopPolling();
    void sample(ctx);
    poll = setInterval(() => void sample(ctx), POLL_MS);
  });

  pi.on("provider_stream_event", (event) => {
    const data = event.data as { usage?: unknown; timings?: unknown } | undefined;
    if (data?.usage) usage = data.usage;
    if (data?.timings) timings = data.timings;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !ctx.hasUI) return;
    stopPolling();
    const stats = requestStats(usage, timings);
    if (!stats) return;
    last = stats;
    totals.requests += 1;
    totals.prefillTokens += stats.prefillTokens;
    totals.prefillMs += stats.prefillMs ?? 0;
    totals.cachedTokens += stats.cachedTokens;
    totals.decodeTokens += stats.decodeTokens;
    totals.decodeMs += stats.decodeMs ?? 0;
    totals.ttftMs += stats.ttftMs ?? 0;
    lastLine = formatRequest(stats);
    show(ctx, [lastLine, server(await metrics())].filter(Boolean).join(" | "));
  });

  pi.on("agent_end", () => stopPolling());
  pi.on("session_shutdown", () => stopPolling());

  pi.registerCommand("stats", {
    description: "Inference stats for the last request and this session",
    handler: async (_args, ctx) => {
      if (!last) {
        ctx.ui.notify("No requests with server stats yet.", "info");
        return;
      }
      const pp = rate(totals.prefillTokens, totals.prefillMs);
      const tg = rate(totals.decodeTokens, totals.decodeMs);
      const lines = [
        `Last request: ${formatRequest(last)}`,
        `  prefilled ${last.prefillTokens.toLocaleString()} tokens, ${last.cachedTokens.toLocaleString()} from cache` +
          (last.queueMs !== undefined ? `, queued ${seconds(last.queueMs)}` : ""),
        `This session: ${totals.requests} request${totals.requests === 1 ? "" : "s"}`,
        `  prefill ${totals.prefillTokens.toLocaleString()} tokens${pp ? ` @ ${compact(pp)} t/s` : ""}, ${totals.cachedTokens.toLocaleString()} from cache`,
        `  decode ${totals.decodeTokens.toLocaleString()} tokens${tg ? ` @ ${compact(tg)} t/s` : ""}`,
        `  mean ttft ${seconds(totals.ttftMs / totals.requests)}`,
      ];
      const m = await metrics();
      if (m) lines.push(`Server: ${server(m)}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
