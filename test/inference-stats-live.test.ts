// Drives the inference-stats extension's handlers with a fake pi, a stubbed
// fetch, and mocked interval timers, to check its live sampling.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import inferenceStats from "../extensions/inference-stats.ts";

type Route = () => unknown | Promise<unknown>;
let routes: Record<string, Route>;
let requests: string[];
const realFetch = globalThis.fetch;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  requests = [];
  routes = { "/props": () => ({ total_slots: 2 }), "/metrics": () => "llamacpp:requests_processing 1\n", "/slots": () => [] };
  globalThis.fetch = (async (url: string) => {
    const { host, pathname } = new URL(url);
    requests.push(`${host}${pathname}`);
    const route = routes[pathname];
    if (!route || host !== "gufo") return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const body = await route();
    return { ok: true, status: 200, json: async () => body, text: async () => String(body) };
  }) as typeof fetch;
  mock.timers.enable({ apis: ["setInterval"] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

const slot = (task: number, decoded: number) => ({
  id_task: task,
  n_prompt_tokens: 3000,
  n_prompt_tokens_cache: 2900,
  n_prompt_tokens_processed: 100,
  next_token: [{ n_decoded: decoded }],
});

const usage = (ttft?: number) => ({
  prompt_tokens: 3000,
  completion_tokens: 50,
  prompt_tokens_details: { cached_tokens: 2900 },
  gufo: { prefill_tokens: 100, prefill_ms: 50, decode_ms: 5000, ...(ttft === undefined ? {} : { ttft_ms: ttft }) },
});

function load(baseUrl = "http://gufo/v1") {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => any }> = {};
  const statuses: string[] = [];
  const notes: string[] = [];
  inferenceStats({
    on: (name: string, fn: any) => (handlers[name] = fn),
    registerCommand: (name: string, options: any) => (commands[name] = options),
  } as any);
  const ctx = {
    hasUI: true,
    model: { baseUrl },
    ui: { setStatus: (_key: string, text?: string) => statuses.push(text ?? ""), notify: (text: string) => notes.push(text) },
  };
  return { handlers, commands, statuses, notes, ctx };
}

/** One poll interval, then time for its fetches to finish. */
async function poll(ms = 40) {
  mock.timers.tick(1000);
  await delay(ms);
}

/** Sends one request the way pi does: awaits before_provider_request, then the server starts it. */
async function send(s: ReturnType<typeof load>) {
  await s.handlers.before_provider_request({ payload: {} }, s.ctx);
}

async function finish(s: ReturnType<typeof load>, ttft?: number) {
  s.handlers.provider_stream_event({ data: { usage: usage(ttft) } });
  await s.handlers.message_end({ message: { role: "assistant" } }, s.ctx);
}

test("the request's own task isn't mistaken for another client's when the first sample is slow", async () => {
  const s = load();
  await s.handlers.session_start({}, s.ctx);
  let started = false;
  routes["/slots"] = async () => {
    await delay(20);
    return started ? [slot(241, 5)] : [slot(-1, 0)];
  };
  await send(s);
  started = true; // the server admits the request once pi has sent it
  await delay(40);
  await poll();
  assert.match(s.statuses.at(-1)!, /^decode 5/);
});

test("live progress stays on this request when another client starts one", async () => {
  const s = load();
  await s.handlers.session_start({}, s.ctx);
  routes["/slots"] = () => [slot(-1, 0)];
  await send(s);
  routes["/slots"] = () => [slot(241, 10)];
  await poll();
  routes["/slots"] = () => [slot(241, 20), slot(242, 5000)];
  await poll();
  assert.match(s.statuses.at(-1)!, /^decode 20 /);
});

test("a sample that finishes after the response ends doesn't overwrite the final stats", async () => {
  const s = load();
  await s.handlers.session_start({}, s.ctx);
  routes["/slots"] = () => [slot(-1, 0)];
  await send(s);
  routes["/slots"] = () => [slot(241, 49)];
  let slowMetrics = true;
  routes["/metrics"] = async () => {
    if (slowMetrics) {
      slowMetrics = false;
      await delay(60);
    }
    return "llamacpp:requests_processing 0\n";
  };
  mock.timers.tick(1000); // a sample starts; its /metrics call is slow
  await delay(10);
  await finish(s, 2000);
  await delay(100);
  assert.match(s.statuses.at(-1)!, /^pp 100 @/);
});

test("doesn't poll a server that didn't answer /props", async () => {
  const s = load("http://cloud.example/v1");
  await s.handlers.session_start({}, s.ctx);
  await send(s);
  await poll();
  await finish(s, 2000);
  assert.deepEqual(requests, ["cloud.example/props"]);
  assert.match(s.statuses.at(-1)!, /^pp 100 @/);
});

test("switching models re-checks the new server before polling it", async () => {
  const s = load();
  await s.handlers.session_start({}, s.ctx);
  await s.handlers.model_select({ model: { baseUrl: "http://cloud.example/v1" } }, s.ctx);
  requests = [];
  await send(s);
  await poll();
  assert.deepEqual(requests, []);
});

test("mean TTFT counts only requests that reported one", async () => {
  const s = load();
  await s.handlers.session_start({}, s.ctx);
  await send(s);
  await finish(s, 2000);
  await send(s);
  await finish(s);
  await s.commands.stats.handler("", s.ctx);
  assert.match(s.notes.at(-1)!, /mean ttft 2\.0s/);
});
