// Write pi-distro's configuration into a pi agent directory. Run by install.sh
// after the packages are installed:
//
//   node scripts/configure.mjs --agent-dir <dir> --package-dir <dir>
//        [--gufo <url>] [--searxng <url>] [--sessions <n>]
//
// Files are only created where none exist. Edits to existing files are
// targeted merges that leave the user's other settings alone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "agent-dir": { type: "string" },
    "package-dir": { type: "string" },
    gufo: { type: "string" },
    searxng: { type: "string" },
    sessions: { type: "string" },
  },
});
const DEFAULT_GUFO = "http://127.0.0.1:8080/v1";
const agentDir = args["agent-dir"];
const packageDir = args["package-dir"];
const sessions = args.sessions === undefined ? undefined : Number(args.sessions);
if (!agentDir || !packageDir || (sessions !== undefined && !(Number.isInteger(sessions) && sessions >= 1))) {
  console.error("usage: node configure.mjs --agent-dir <dir> --package-dir <dir> [--gufo <url>] [--searxng <url>] [--sessions <n>]");
  process.exit(1);
}
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = (name) => path.join(here, "config", name);
const target = (...parts) => path.join(agentDir, ...parts);
// pi-deep-research reads its providers and settings from ~/.pi/agent, whatever the agent directory.
const researchDir = path.join(os.homedir(), ".pi", "agent", "pi-deep-research");

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { missing: error.code === "ENOENT", invalid: error.code !== "ENOENT" };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy a file into place unless the user already has one. */
function seed(from, to) {
  if (fs.existsSync(to)) {
    console.log(`  kept ${to}`);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  wrote ${to}`);
}

/** Read a JSON file to merge into; undefined (with a warning) when it exists but can't be parsed. */
function mergeTarget(file) {
  const current = readJson(file);
  if (current.invalid) {
    console.warn(`  skipped ${file}: it isn't valid JSON`);
    return undefined;
  }
  return current.value ?? {};
}

for (const agent of fs.readdirSync(path.join(here, "agents")).filter((f) => f.endsWith(".md"))) {
  seed(path.join(here, "agents", agent), target("agents", agent));
}
seed(config("pi-todo-config.json"), target("pi-todo", "config.json"));
configureDistro();
bindThinkingCycle();
await configureModels();
configureSettings();
await configureResearch();

/** pi-distro.json, with the subagent concurrency from --sessions. */
function configureDistro() {
  const file = target("pi-distro.json");
  const current = mergeTarget(file);
  if (!current) return;
  const defaults = readJson(config("pi-distro.json")).value;
  const next = { ...defaults, ...current };
  if (sessions !== undefined) next.subagentConcurrency = sessions;
  writeJson(file, next);
  console.log(`  wrote ${file}: ${next.subagentConcurrency} parallel subagents`);
}

/** pi binds shift+tab to the thinking cycle; plan mode takes shift+tab, so thinking moves to alt+t. */
function bindThinkingCycle() {
  const file = target("keybindings.json");
  const current = mergeTarget(file);
  if (!current || "app.thinking.cycle" in current) return;
  writeJson(file, { ...current, ...readJson(config("keybindings.json")).value });
  console.log(`  wrote ${file}: thinking level cycles with alt+t`);
}

/** Adds a gufo provider to models.json from the server's /models, or from the template when it's down. */
async function configureModels() {
  const file = target("models.json");
  const current = mergeTarget(file);
  if (!current) return;
  current.providers ??= {};
  const baseUrl = (args.gufo ?? DEFAULT_GUFO).replace(/\/+$/, "");
  if (current.providers.gufo) {
    if (args.gufo && current.providers.gufo.baseUrl !== baseUrl) {
      current.providers.gufo.baseUrl = baseUrl;
      writeJson(file, current);
      console.log(`  wrote ${file}: gufo provider moved to ${baseUrl}`);
    } else {
      console.log(`  kept the gufo provider in ${file}`);
    }
    return;
  }
  const template = readJson(config("models.template.json")).value.providers.gufo;
  const provider = { ...template, baseUrl };
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    const served = (await response.json()).data ?? [];
    if (served.length > 0) {
      const base = template.models[0];
      provider.models = served.map((m) => ({
        ...base,
        id: m.id,
        name: `${m.id} (gufo)`,
        input: m.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
        contextWindow: m.context_length ?? base.contextWindow,
      }));
      console.log(`  found ${served.map((m) => m.id).join(", ")} on ${baseUrl}`);
    }
  } catch {
    console.warn(`  couldn't reach gufo at ${baseUrl}; added its usual models. Edit ${file} if the IDs differ.`);
  }
  current.providers.gufo = provider;
  writeJson(file, current);
  console.log(`  wrote ${file}: gufo provider at ${baseUrl}`);
}

/** Default model, compaction, pi-lsp's skill, and the language servers found on PATH. */
function configureSettings() {
  const file = target("settings.json");
  const settings = mergeTarget(file);
  if (!settings) return;
  const models = readJson(target("models.json")).value?.providers?.gufo?.models ?? [];
  if (!settings.defaultProvider && models.length > 0) {
    settings.defaultProvider = "gufo";
    settings.defaultModel = models[0].id;
    console.log(`  default model: gufo/${models[0].id}`);
  }
  settings.compaction ??= {};
  settings.compaction.keepRecentTokens ??= 12000;

  // pi-lsp's model-facing tools are turned off (see tool-loadout.ts), so its skill about them is dropped too.
  settings.packages = (settings.packages ?? []).map((entry) =>
    typeof entry === "string" && /^npm:@ian-pascoe\/pi-lsp(@|$)/.test(entry) ? { source: entry, skills: [] } : entry,
  );
  // Earlier installs of this distro from another directory (a clone used with --dev, or the copy).
  settings.packages = settings.packages.filter((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    if (typeof source !== "string" || /^(npm|git|https?):/.test(source)) return true;
    const resolved = path.resolve(agentDir, source);
    if (resolved === path.resolve(packageDir)) return true;
    const isDistro = readJson(path.join(resolved, "package.json")).value?.name === "pi-distro";
    if (isDistro) console.log(`  removed the earlier install at ${resolved} from pi's packages`);
    return !isDistro;
  });

  if (!settings.lsp) {
    const servers = languageServers();
    if (Object.keys(servers).length > 0) {
      settings.lsp = { servers };
      console.log(`  language servers: ${Object.keys(servers).join(", ")}`);
    } else {
      console.log("  no language servers found on PATH; install some for diagnostics after edits");
    }
  }
  writeJson(file, settings);
  console.log(`  wrote ${file}`);
}

function onPath(command) {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** pi-lsp server definitions for the servers installed; a missing server would add noise to every edit. */
function languageServers() {
  const candidates = [
    ["typescript", ["typescript-language-server", "--stdio"], [[[".ts", ".mts", ".cts"], "typescript"], [[".tsx"], "typescriptreact"], [[".js", ".mjs", ".cjs"], "javascript"], [[".jsx"], "javascriptreact"]]],
    ["python", ["basedpyright-langserver", "--stdio"], [[[".py", ".pyi"], "python"]]],
    ["python", ["pyright-langserver", "--stdio"], [[[".py", ".pyi"], "python"]]],
    ["rust", ["rust-analyzer"], [[[".rs"], "rust"]]],
    ["go", ["gopls"], [[[".go"], "go"]]],
    ["cpp", ["clangd"], [[[".c", ".h", ".cc", ".cpp", ".hpp", ".cxx"], "cpp"]]],
  ];
  const servers = {};
  for (const [name, [command, ...commandArgs], languages] of candidates) {
    if (servers[name] || !onPath(command)) continue;
    servers[name] = {
      command,
      args: commandArgs,
      languages: languages.map(([extensions, languageId]) => ({ extensions, languageId })),
    };
  }
  return servers;
}

/** Search providers for pi-deep-research, its provider chain, and the SearXNG URL. */
async function configureResearch() {
  for (const provider of fs.readdirSync(path.join(here, "providers")).filter((f) => f.endsWith(".ts"))) {
    fs.mkdirSync(path.join(researchDir, "providers"), { recursive: true });
    fs.copyFileSync(path.join(here, "providers", provider), path.join(researchDir, "providers", provider));
  }
  console.log(`  wrote search providers to ${path.join(researchDir, "providers")}`);
  seed(config("deep-research.json"), path.join(researchDir, "config.json"));
  const chain = readJson(path.join(researchDir, "config.json")).value?.providers;
  if (Array.isArray(chain) && !chain.includes("exa-mcp") && !chain.includes("searxng")) {
    console.warn(`  ${path.join(researchDir, "config.json")} uses neither searxng nor exa-mcp; add them to "providers" to use them`);
  }
  if (!args.searxng) return;

  const baseUrl = args.searxng.replace(/\/+$/, "");
  writeJson(path.join(researchDir, "searxng.json"), { baseUrl });
  console.log(`  wrote ${path.join(researchDir, "searxng.json")}: ${baseUrl}`);
  try {
    const response = await fetch(`${baseUrl}/search?q=test&format=json`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 403) {
      console.warn("  SearXNG refused JSON (403): add json to search.formats in its settings.yml");
    } else if (!response.ok) {
      console.warn(`  SearXNG answered ${response.status} to a test search`);
    }
  } catch (error) {
    console.warn(`  couldn't reach SearXNG at ${baseUrl}: ${error.message}`);
  }
}
