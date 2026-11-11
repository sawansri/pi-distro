// Runs scripts/configure.mjs against temporary directories and stub /v1/models servers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const script = path.join(import.meta.dirname, "..", "scripts", "configure.mjs");
const servers: http.Server[] = [];

after(() => servers.forEach((server) => server.close()));

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-distro-configure-"));
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(home);
  return { root, agentDir, home };
}

async function configure(d: ReturnType<typeof dirs>, ...args: string[]) {
  await promisify(execFile)(process.execPath, [script, "--agent-dir", d.agentDir, "--package-dir", path.join(d.agentDir, "pi-distro"), ...args], {
    env: { ...process.env, HOME: d.home, LLM_GATEWAY_KEY: "test-key" },
  });
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * A gateway whose /models answers with `entries`, so the installer path that
 * reads the catalogue (rather than the template) gets tested.
 */
async function catalogServer(entries: unknown[]): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: entries }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const catalogEntry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  owned_by: "AzureOpenAI",
  capabilities: { chat: true, vision: true, responses: false },
  context_length: 1000000,
  max_output_tokens: 128000,
  pricing: {
    input_per_million: 0.5,
    output_per_million: 2,
    cache_read_input_per_million: 0.05,
    cache_creation_input_per_million: 0.25,
  },
  ...extra,
});

test("each catalogue model is filed under the api it is actually served on", async () => {
  // A chat-completions-only model sent to /responses does not fail on this
  // gateway: it answers from an unpinned default pool and is billed under the
  // name that was asked for. So the generated models.json has to declare the
  // right api per model, not one api for the whole provider.
  const d = dirs();
  await configure(
    d,
    "--gateway",
    await catalogServer([
      catalogEntry("chat-only-model"),
      catalogEntry("responses-model", { capabilities: { chat: true, responses: true } }),
      catalogEntry("Claude-Haiku-5-5", { owned_by: "AzureOpenAI-Anthropic" }),
      catalogEntry("embedding-model", { capabilities: { chat: false, embedding: true } }),
    ]),
  );
  const models = readJson(path.join(d.agentDir, "models.json"));
  const ids = (name: string) => models.providers[name].models.map((m: { id: string }) => m.id);
  assert.deepEqual(ids("gateway").sort(), ["chat-only-model", "responses-model"]);
  assert.deepEqual(ids("gateway-anthropic"), ["Claude-Haiku-5-5"]);
  const apiOf = (id: string) =>
    models.providers.gateway.models.find((m: { id: string }) => m.id === id).api;
  assert.equal(apiOf("chat-only-model"), "openai-completions");
  assert.equal(apiOf("responses-model"), "openai-responses");
});

test("a catalogue model carries the gateway's own price and cache lifetimes", async () => {
  const d = dirs();
  await configure(d, "--gateway", await catalogServer([
    catalogEntry("priced", {
      pricing: {
        input_per_million: 1.36,
        output_per_million: 6.8,
        cache_read_input_per_million: 0.068,
        cache_creation_input_per_million: 1.7,
        cache_creation_1h_per_million: 2.72,
      },
    }),
  ]));
  const model = readJson(path.join(d.agentDir, "models.json")).providers.gateway.models[0];
  assert.deepEqual(model.cost, { input: 1.36, output: 6.8, cacheRead: 0.068, cacheWrite: 1.7 });
  // pi warms only the tiers a model declares a lifetime for.
  assert.deepEqual(model.promptCache, { short: 300, long: 3600 });
});

test("a placeholder template URL is never installed as a provider", async () => {
  // The template is a fallback for a real --gateway. Installing its
  // llm-api.example.com URL leaves a provider that always fails and quietly
  // becomes the default model.
  const d = dirs();
  await configure(d);
  const models = readJson(path.join(d.agentDir, "models.json"));
  assert.deepEqual(Object.keys(models.providers ?? {}), []);
});

test("a real gateway gets the template's providers and prices", async () => {
  const d = dirs();
  await configure(d, "--gateway", "https://gw.example.dev/v1", "--anthropic", "https://gw.example.dev/Unified");
  const models = readJson(path.join(d.agentDir, "models.json"));
  assert.equal(models.providers["gateway-anthropic"].baseUrl, "https://gw.example.dev/Unified");
  assert.equal(models.providers.gateway.baseUrl, "https://gw.example.dev/v1");
  // Real prices, so the footer and /session show money rather than zeros.
  const sonnet = models.providers["gateway-anthropic"].models.find((m: { id: string }) => m.id === "Claude-Sonnet-5-5");
  assert.ok(sonnet.cost.input > 0 && sonnet.cost.cacheRead < sonnet.cost.input);
  assert.equal(readJson(path.join(d.agentDir, "settings.json")).defaultProvider, "gateway-anthropic");
});

test("--gateway and --anthropic move an existing provider without replacing its models", async () => {
  const d = dirs();
  await configure(d, "--gateway", "https://gw.example.dev/v1", "--anthropic", "https://gw.example.dev/Unified");
  const file = path.join(d.agentDir, "models.json");
  const models = readJson(file);
  models.providers.gateway.models = [{ id: "only-mine", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }];
  fs.writeFileSync(file, JSON.stringify(models));
  await configure(d, "--gateway", "https://moved.example.dev/v1");
  const moved = readJson(file).providers.gateway;
  assert.equal(moved.baseUrl, "https://moved.example.dev/v1");
  assert.deepEqual(moved.models.map((m: { id: string }) => m.id), ["only-mine"]);
});

test("--gateway is not swallowed by an unrelated provider on the same api", async () => {
  // A user with api.openai.com configured must still get the gateway they asked
  // for; matching "any provider with this api" would silently discard it.
  const d = dirs();
  fs.writeFileSync(
    path.join(d.agentDir, "models.json"),
    JSON.stringify({
      providers: { other: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", models: [{ id: "gpt-x" }] } },
    }),
  );
  await configure(d, "--gateway", "https://my-gw.internal.dev/v1");
  const providers = readJson(path.join(d.agentDir, "models.json")).providers;
  assert.equal(providers.gateway.baseUrl, "https://my-gw.internal.dev/v1");
  assert.equal(providers.other.baseUrl, "https://api.openai.com/v1");
});

test("an agent's own model: line survives a reinstall, and empty keys are replaced not duplicated", async () => {
  const d = dirs();
  const agents = path.join(d.agentDir, "agents");
  fs.mkdirSync(agents, { recursive: true });
  const reviewer = path.join(agents, "reviewer.md");
  fs.writeFileSync(
    reviewer,
    "---\nname: reviewer\ndescription: mine\nmodel: gateway-anthropic/Claude-Opus-5-5\nthinking: xhigh\n---\nbody\n",
  );
  const plan = path.join(agents, "plan.md");
  fs.writeFileSync(plan, "---\nname: plan\ndescription: mine\nmodel:\nthinking:\n---\nbody\n");
  await configure(d, "--gateway", "https://gw.example.dev/v1");
  assert.match(fs.readFileSync(reviewer, "utf8"), /^model: gateway-anthropic\/Claude-Opus-5-5$/m);
  // An empty `model:` left in place beside a generated one makes the
  // frontmatter unparseable, and pi-lite-subagent then drops the agent.
  const planText = fs.readFileSync(plan, "utf8");
  assert.equal(planText.match(/^model:/gm)?.length, 1, planText);
  assert.equal(planText.match(/^thinking:/gm)?.length, 1, planText);
  assert.doesNotMatch(planText, /^model:\s*$/m, planText);
});

test("changing agentModels takes effect on an agent the installer already set", async () => {
  // The installer marks the lines it writes, so a later run can revise its own
  // choice while leaving one the user typed alone.
  const d = dirs();
  await configure(d, "--gateway", "https://gw.example.dev/v1");
  const reviewer = path.join(d.agentDir, "agents", "reviewer.md");
  assert.match(fs.readFileSync(reviewer, "utf8"), /^model: gateway\/gpt-6\.1-sol # pi-distro$/m);
  const settings = path.join(d.agentDir, "pi-distro.json");
  fs.writeFileSync(settings, JSON.stringify({ ...readJson(settings), agentModels: { reviewer: { model: "gpt-6-luna" } } }));
  await configure(d, "--gateway", "https://gw.example.dev/v1");
  const text = fs.readFileSync(reviewer, "utf8");
  assert.match(text, /^model: gateway\/gpt-6-luna # pi-distro$/m);
  // An omitted thinking level keeps the role's default rather than vanishing.
  assert.match(text, /^thinking: high # pi-distro$/m);
});

test("--gateway alone also points the Anthropic provider at the gateway root", async () => {
  // The Anthropic path is served from the root, not /v1. Without deriving it,
  // --gateway left the Claude models on the template's placeholder URL and
  // dropped them entirely.
  const d = dirs();
  await configure(d, "--gateway", "https://gw.example.dev/v1");
  const providers = readJson(path.join(d.agentDir, "models.json")).providers;
  assert.equal(providers["gateway-anthropic"].baseUrl, "https://gw.example.dev");
});

test("an explicit --gateway is accepted even on a host that looks like a placeholder", async () => {
  // example.com is a real documentation host; only the template's own host is
  // a placeholder.
  const d = dirs();
  await configure(d, "--gateway", "https://llm.example.com/v1");
  const providers = readJson(path.join(d.agentDir, "models.json")).providers;
  assert.equal(providers.gateway.baseUrl, "https://llm.example.com/v1");
});

test("both paths at one base URL still install both API families", async () => {
  const d = dirs();
  await configure(d, "--gateway", "https://gw.internal.dev/v1", "--anthropic", "https://gw.internal.dev/v1");
  const providers = readJson(path.join(d.agentDir, "models.json")).providers;
  assert.ok(providers.gateway, "OpenAI provider missing");
  assert.ok(providers["gateway-anthropic"], "Anthropic provider missing");
});

test("the gateway search provider is installed with the gateway chain", async () => {
  const d = dirs();
  await configure(d);
  const research = path.join(d.home, ".pi", "agent", "pi-deep-research");
  assert.ok(fs.existsSync(path.join(research, "providers", "gateway.ts")));
  assert.deepEqual(readJson(path.join(research, "config.json")).providers, ["gateway"]);
});

test("an earlier install listed as ~/... or file://... is removed", async () => {
  const d = dirs();
  for (const name of ["clone-a", "clone-b"]) {
    fs.mkdirSync(path.join(d.home, name));
    fs.writeFileSync(path.join(d.home, name, "package.json"), JSON.stringify({ name: "pi-distro" }));
  }
  const packages = ["npm:pi-todo-lite@0.3.0", "~/clone-a", `file://${path.join(d.home, "clone-b")}`, "github:someone/pi-tools"];
  fs.writeFileSync(path.join(d.agentDir, "settings.json"), JSON.stringify({ packages }));
  await configure(d);
  assert.deepEqual(readJson(path.join(d.agentDir, "settings.json")).packages, ["npm:pi-todo-lite@0.3.0", "github:someone/pi-tools"]);
});
