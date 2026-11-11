// Runs scripts/configure.mjs against temporary directories and stub /v1/models servers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const script = path.join(import.meta.dirname, "..", "scripts", "configure.mjs");

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

test("the gateway providers are seeded from the template", async () => {
  const d = dirs();
  await configure(d);
  const models = readJson(path.join(d.agentDir, "models.json"));
  assert.equal(models.providers["gateway-anthropic"].baseUrl, "https://llm-api.example.com/Unified");
  assert.equal(models.providers.gateway.baseUrl, "https://llm-api.example.com/Unified/v1");
  // Real prices, so the footer and /session show money rather than zeros.
  const sonnet = models.providers["gateway-anthropic"].models.find((m: { id: string }) => m.id === "Claude-Sonnet-5.5");
  assert.ok(sonnet.cost.input > 0 && sonnet.cost.cacheRead < sonnet.cost.input);
  assert.equal(readJson(path.join(d.agentDir, "settings.json")).defaultProvider, "gateway-anthropic");
});

test("--gateway and --anthropic move an existing provider without replacing its models", async () => {
  const d = dirs();
  await configure(d);
  const file = path.join(d.agentDir, "models.json");
  const models = readJson(file);
  models.providers.gateway.models = [{ id: "only-mine", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }];
  fs.writeFileSync(file, JSON.stringify(models));
  await configure(d, "--gateway", "https://moved.example/v1");
  const moved = readJson(file).providers.gateway;
  assert.equal(moved.baseUrl, "https://moved.example/v1");
  assert.deepEqual(moved.models.map((m: { id: string }) => m.id), ["only-mine"]);
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
