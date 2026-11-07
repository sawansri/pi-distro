/**
 * Prompt-cache guard.
 *
 * Local servers reuse their prompt cache only on an exact token prefix, and
 * Qwen renders the system prompt, the tool list and the reasoning effort at
 * the very start. Anything that changes one of them, or rewrites earlier
 * history, makes the server reprocess the whole conversation. This extension
 * shows the cache hit rate in the footer and warns, with the cause, when a
 * request reprocesses more than PI_DISTRO_CACHE_WARN_TOKENS (default 1024)
 * that the previous request had already processed.
 *
 * New content in a request (tool results, the user's message) always has to
 * be processed, so it doesn't count as a miss: a request can reuse at most the
 * previous request's prompt, and the hit rate is cached / reusable tokens.
 *
 * Causes are found by comparing each request payload with the previous one:
 * the leading system message, the tool list, the reasoning effort, and
 * whether the previous messages are still a prefix of the new ones. gufo's
 * own `cache_miss_reason` is added when the server reports one.
 *
 * Set PI_DISTRO_CACHE_LOG to a file path to append one JSON line per request,
 * which also works without a UI (print mode, subagents).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WARN_TOKENS = Number(process.env.PI_DISTRO_CACHE_WARN_TOKENS) || 1024;
const LOG = process.env.PI_DISTRO_CACHE_LOG;

interface Snapshot {
  system: string;
  tools: string;
  effort: string;
  /** Hash of each message, in order. */
  messages: string[];
}

interface RawUsage {
  prompt_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  gufo?: { cache_miss_reason?: string; cache_common_prefix_tokens?: number };
  cache_miss_reason?: string;
  cache_common_prefix_tokens?: number;
}

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value) ?? "").digest("hex");

function snapshot(payload: any): Snapshot | undefined {
  if (!Array.isArray(payload?.messages)) return undefined;
  const [first, ...rest] = payload.messages;
  const leadingSystem = first?.role === "system" || first?.role === "developer";
  return {
    system: leadingSystem ? hash(first.content) : "",
    tools: hash(payload.tools ?? []),
    effort: String(payload.reasoning_effort ?? payload.chat_template_kwargs?.enable_thinking ?? ""),
    messages: (leadingSystem ? rest : payload.messages).map(hash),
  };
}

/** Tokens of the previous prompt this request could have reused but processed again. */
export function missedTokens(prompt: number, cached: number, previousPrompt: number | undefined): number {
  if (previousPrompt === undefined) return 0;
  return Math.max(0, Math.min(prompt, previousPrompt) - cached);
}

/** Why `next` can't reuse the cache built by `prev`, or undefined if it only appends. */
function headChange(prev: Snapshot, next: Snapshot): string | undefined {
  if (prev.system !== next.system) return "system prompt changed";
  if (prev.tools !== next.tools) return "tool list changed";
  if (prev.effort !== next.effort) return "reasoning effort changed";
  const kept = prev.messages.every((h, i) => next.messages[i] === h);
  return kept ? undefined : "earlier messages changed";
}

export default function (pi: ExtensionAPI) {
  let prev: Snapshot | undefined;
  let pending: Snapshot | undefined;
  let cause: string | undefined;
  let compacted = false;
  let usage: RawUsage | undefined;
  let previousPrompt: number | undefined;
  let requests = 0;
  let reusableTotal = 0;
  let cachedTotal = 0;

  const reset = () => {
    prev = pending = undefined;
    previousPrompt = undefined;
    cause = undefined;
    compacted = false;
    requests = reusableTotal = cachedTotal = 0;
  };

  pi.on("session_start", (_event, ctx) => {
    reset();
    ctx.ui.setStatus("cache", undefined);
  });

  pi.on("session_compact", () => {
    compacted = true;
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (requests > 0 && event.level !== event.previousLevel) {
      ctx.ui.notify(
        `Thinking level ${event.previousLevel} → ${event.level}: the next request reprocesses the whole conversation once.`,
        "warning",
      );
    }
  });

  pi.on("before_provider_request", (event) => {
    pending = snapshot(event.payload);
    cause = prev && pending ? headChange(prev, pending) : undefined;
    if (compacted) cause = "compaction";
    usage = undefined;
  });

  pi.on("provider_stream_event", (event) => {
    const data = event.data as { usage?: RawUsage } | undefined;
    if (data?.usage) usage = data.usage;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !pending) return;
    const normalized = (event.message as { usage?: { input?: number; cacheRead?: number } }).usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? normalized?.cacheRead ?? 0;
    const prompt = usage?.prompt_tokens ?? (normalized?.input ?? 0) + cached;
    const missed = missedTokens(prompt, cached, previousPrompt);
    const serverReason = usage?.gufo?.cache_miss_reason ?? usage?.cache_miss_reason;
    const isFirst = previousPrompt === undefined;

    requests += 1;
    if (!isFirst) {
      reusableTotal += Math.min(prompt, previousPrompt!);
      cachedTotal += Math.min(prompt, previousPrompt!) - missed;
    }
    report(ctx, { prompt, cached, missed, cause, serverReason, isFirst });

    previousPrompt = prompt;
    prev = pending;
    pending = undefined;
    compacted = false;
  });

  function report(
    ctx: ExtensionContext,
    r: { prompt: number; cached: number; missed: number; cause?: string; serverReason?: string; isFirst: boolean },
  ) {
    if (LOG) {
      fs.appendFileSync(LOG, `${JSON.stringify({ time: new Date().toISOString(), ...r })}\n`);
    }
    if (!ctx.hasUI) return;
    if (reusableTotal > 0) ctx.ui.setStatus("cache", `cache ${Math.floor((100 * cachedTotal) / reusableTotal)}%`);
    if (r.missed >= WARN_TOKENS) {
      const why = [r.cause, r.serverReason && `server: ${r.serverReason}`].filter(Boolean).join("; ");
      ctx.ui.notify(
        `Prompt cache miss: reprocessed ${r.missed.toLocaleString()} tokens the server had already processed${why ? ` (${why})` : ""}.`,
        "warning",
      );
    }
  }
}
