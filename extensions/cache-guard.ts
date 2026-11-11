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

/**
 * A stable digest of one value. Falls back to a marker rather than throwing:
 * a payload that cannot be serialized is not a payload worth crashing a request
 * over, and `snapshot` runs inside `before_provider_request`.
 */
function hash(value: unknown): string {
  try {
    return createHash("sha1").update(JSON.stringify(value) ?? "undefined").digest("hex");
  } catch {
    return "unhashable";
  }
}

/** Whether a list is a conversation: objects with a role. */
const isTurns = (list: unknown): list is unknown[] =>
  Array.isArray(list) && list.every((item) => typeof item === "object" && item !== null && "role" in item);

/**
 * Whether a list is Responses `input`: message items carry a role, and the
 * others (function calls and their outputs) carry a type instead.
 */
const isItems = (list: unknown): list is unknown[] =>
  Array.isArray(list) &&
  list.every((item) => typeof item === "object" && item !== null && ("role" in item || "type" in item));

/**
 * A request reduced to the parts a prompt cache is keyed on.
 *
 * Each API names them differently. Chat Completions sends `messages` with a
 * leading system message; the Responses API sends `instructions` plus an `input`
 * array of items; Anthropic Messages sends `system` and `messages`. Knowing only
 * the first made this extension silently do nothing on the Responses path, where
 * most of this distro's models live.
 *
 * A payload of any other shape returns undefined rather than a snapshot: a
 * guessed shape would report a cache miss on every request from a provider this
 * guard does not understand. Nothing here throws.
 */
export function snapshot(payload: any): Snapshot | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const effort = String(
    payload.reasoning_effort ?? payload.reasoning?.effort ?? payload.chat_template_kwargs?.enable_thinking ?? "",
  );
  const tools = hash(payload.tools ?? []);
  // Anthropic first: it also sends `messages`, so testing that first would read
  // its top-level `system` as an empty one.
  if (payload.system !== undefined) {
    if (!isTurns(payload.messages)) return undefined;
    return { system: hash(payload.system), tools, effort, messages: payload.messages.map(hash) };
  }
  if (isTurns(payload.messages)) {
    const messages = payload.messages as { role?: string; content?: unknown }[];
    const leadingSystem = ["system", "developer"].includes(messages[0]?.role ?? "");
    const rest = leadingSystem ? messages.slice(1) : messages;
    return { system: leadingSystem ? hash(messages[0].content) : "", tools, effort, messages: rest.map(hash) };
  }
  if (typeof payload.instructions === "string" || payload.input !== undefined) {
    if (typeof payload.input === "string") {
      return { system: hash(payload.instructions ?? ""), tools, effort, messages: [hash({ role: "user", content: payload.input })] };
    }
    if (!isItems(payload.input)) return undefined;
    // A leading developer/system item is the system prompt, as in chat form.
    const items = payload.input as { role?: string }[];
    const leadingSystem = ["system", "developer"].includes(items[0]?.role ?? "");
    const rest = leadingSystem ? items.slice(1) : items;
    const system = hash(payload.instructions ?? "") + (leadingSystem ? hash(items[0]) : "");
    return { system, tools, effort, messages: rest.map(hash) };
  }
  return undefined;
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
    // A failed or stopped request reports no usable usage; compare the next one with the last good one.
    const stopReason = (event.message as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted" || (!usage && !(event.message as { usage?: unknown }).usage)) {
      pending = undefined;
      return;
    }
    const normalized = (event.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? normalized?.cacheRead ?? 0;
    // Cache writes are part of the prompt too. Anthropic reports them outside
    // `input`, so leaving them out understates the prompt after a cache loss and
    // the miss then falls under the warning threshold.
    const prompt = usage?.prompt_tokens ?? (normalized?.input ?? 0) + cached + (normalized?.cacheWrite ?? 0);
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
