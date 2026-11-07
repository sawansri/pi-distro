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

/** A server whose /v1/models lists one model; resolves to its base URL. */
async function modelsServer(id: string): Promise<string> {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ data: [{ id, context_length: 65536 }] })));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

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
    env: { ...process.env, HOME: d.home },
  });
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("moving gufo to another server picks up that server's models", async () => {
  const d = dirs();
  await configure(d, "--gufo", await modelsServer("model-a"));
  const b = await modelsServer("model-b");
  await configure(d, "--gufo", b);
  const gufo = readJson(path.join(d.agentDir, "models.json")).providers.gufo;
  assert.equal(gufo.baseUrl, b);
  assert.deepEqual(gufo.models.map((m: { id: string }) => m.id), ["model-b"]);
  assert.equal(readJson(path.join(d.agentDir, "settings.json")).defaultModel, "model-b");
});

test("an earlier install listed as ~/... or file://... is removed", async () => {
  const d = dirs();
  for (const name of ["clone-a", "clone-b"]) {
    fs.mkdirSync(path.join(d.home, name));
    fs.writeFileSync(path.join(d.home, name, "package.json"), JSON.stringify({ name: "pi-distro" }));
  }
  const packages = ["npm:pi-todo-lite@0.3.0", "~/clone-a", `file://${path.join(d.home, "clone-b")}`, "github:someone/pi-tools"];
  fs.writeFileSync(path.join(d.agentDir, "settings.json"), JSON.stringify({ packages }));
  await configure(d, "--gufo", await modelsServer("model-a"));
  assert.deepEqual(readJson(path.join(d.agentDir, "settings.json")).packages, ["npm:pi-todo-lite@0.3.0", "github:someone/pi-tools"]);
});
