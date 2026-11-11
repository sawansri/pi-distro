// Write pi-distro's configuration into a pi agent directory. Run by install.sh
// after the packages are installed:
//
//   node scripts/configure.mjs --agent-dir <dir> --package-dir <dir>
//        [--gateway <url>] [--anthropic <url>] [--concurrency <n>]
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
    gateway: { type: "string" },
    anthropic: { type: "string" },
    concurrency: { type: "string" },
    sessions: { type: "string" },
  },
});
const agentDir = args["agent-dir"];
const packageDir = args["package-dir"];
// --sessions is the local branch's name for the same setting; keep accepting it.
const rawConcurrency = args.concurrency ?? args.sessions;
const concurrency = rawConcurrency === undefined ? undefined : Number(rawConcurrency);
if (!agentDir || !packageDir || (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1))) {
  console.error(
    "usage: node configure.mjs --agent-dir <dir> --package-dir <dir> [--gateway <url>] [--anthropic <url>] [--concurrency <n>]",
  );
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
configureSearchModel();

/** pi-distro.json, with the subagent concurrency from --concurrency. */
function configureDistro() {
  const file = target("pi-distro.json");
  const current = mergeTarget(file);
  if (!current) return;
  const defaults = readJson(config("pi-distro.json")).value;
  const next = { ...defaults, ...current };
  if (concurrency !== undefined) next.subagentConcurrency = concurrency;
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

/** Adds the gateway providers to models.json, seeded from the template. */
async function configureModels() {
  const file = target("models.json");
  const current = mergeTarget(file);
  if (!current) return;
  current.providers ??= {};
  const template = readJson(config("models.template.json")).value.providers ?? {};
  const overrides = { gateway: args.gateway, "gateway-anthropic": args.anthropic };
  let added = 0;
  for (const [name, spec] of Object.entries(template)) {
    const existing = current.providers[name];
    const baseUrl = (overrides[name] ?? existing?.baseUrl ?? spec.baseUrl).replace(/\/+$/, "");
    if (!existing) {
      // Reuse a provider the user already has for the same endpoint and API
      // instead of adding a second name for one service (amd-gateway, say).
      const real = (url) => typeof url === "string" && /^https?:/.test(url) && !/example\.(com|org|net)/.test(url);
      const twin =
        Object.entries(current.providers).find(
          ([, provider]) =>
            provider?.api === spec.api &&
            String(provider?.baseUrl ?? "").replace(/\/+$/, "") === baseUrl &&
            (provider.models ?? []).length > 0,
        ) ??
        // Otherwise any real provider speaking the same API already is the gateway.
        Object.entries(current.providers).find(
          ([, provider]) => provider?.api === spec.api && real(provider?.baseUrl) && (provider.models ?? []).length > 0,
        );
      if (twin) {
        console.log(`  ${name}: using the existing ${twin[0]} provider for ${baseUrl}`);
        continue;
      }
      // The template carries a placeholder URL, which is not a gateway. Adding
      // it would leave a provider that always fails; only add a real one.
      if (!overrides[name] && /example\.(com|org|net)$/.test(baseUrl.replace(/\/.*$/, ""))) {
        console.log(`  ${name}: no gateway URL given, not adding a placeholder provider`);
        continue;
      }
    }
    if (existing) {
      // --gateway / --anthropic move a provider; its model list is the user's.
      if (overrides[name] && existing.baseUrl !== baseUrl) {
        existing.baseUrl = baseUrl;
        console.log(`  ${name} moved to ${baseUrl}`);
      } else {
        console.log(`  kept the ${name} provider in ${file}`);
      }
      continue;
    }
    current.providers[name] = { ...spec, baseUrl };
    added += 1;
    console.log(`  added ${name} at ${baseUrl}`);
  }
  writeJson(file, current);
  const key = process.env.LLM_GATEWAY_KEY;
  if (!key && added > 0) {
    console.warn(
      `  ${file} reads $LLM_GATEWAY_KEY; export it (and any other key ${file} names) or the gateway returns 401`,
    );
  }
  console.log(`  wrote ${file}`);
}

/** A local package source resolved as pi does: ~ is the home directory, file:// URLs are paths. */
function localPackagePath(source) {
  const trimmed = source.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  return path.resolve(agentDir, trimmed);
}

/** Default model, compaction, pi-lsp's skill, and the language servers found on PATH. */
function configureSettings() {
  const file = target("settings.json");
  const settings = mergeTarget(file);
  if (!settings) return;
  // Only set a default when the user has none that still resolves. Prefer a
  // provider whose api can search, since web search is the point of this branch.
  const providers = readJson(target("models.json")).value?.providers ?? {};
  const withModels = Object.entries(providers).filter(([, provider]) => (provider?.models ?? []).length > 0);
  const searchable = withModels.filter(([, provider]) => ["anthropic-messages", "openai-responses"].includes(provider.api));
  const known = (name, id) => (providers[name]?.models ?? []).some((model) => model.id === id);
  const currentKnown = settings.defaultProvider ? known(settings.defaultProvider, settings.defaultModel) : false;
  const [name, provider] = (searchable.length > 0 ? searchable : withModels)[0] ?? [];
  if (name && !currentKnown) {
    settings.defaultProvider = name;
    settings.defaultModel = provider.models[0].id;
    console.log(`  default model: ${name}/${settings.defaultModel}`);
  } else if (settings.defaultProvider) {
    console.log(`  kept the default model: ${settings.defaultProvider}/${settings.defaultModel ?? ""}`);
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
    if (typeof source !== "string" || /^(npm|git|github|https?|ssh|builtin):/.test(source.trim())) return true;
    const resolved = localPackagePath(source);
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

/** The gateway search provider for pi-deep-research, and its provider chain. */
/** Point the gateway search provider at a model this install actually has. */
function configureSearchModel() {
  const file = target("pi-distro.json");
  const settings = mergeTarget(file);
  if (!settings) return;
  const providers = readJson(target("models.json")).value?.providers ?? {};
  const rank = (provider) => (provider?.api === "anthropic-messages" ? 0 : provider?.api === "openai-responses" ? 1 : 9);
  const candidates = Object.entries(providers)
    .filter(([, provider]) => (provider?.models ?? []).length > 0 && rank(provider) < 9)
    .sort((a, b) => rank(a[1]) - rank(b[1]));
  const [name, provider] = candidates[0] ?? [];
  if (!name) {
    console.warn("  no gateway provider found; web search and /research will have no backend");
    return;
  }
  // Haiku/Sonnet before Opus: searching is a cheap, high-volume call.
  const models = provider.models.map((model) => model.id);
  const chosen =
    models.find((id) => /haiku|flash|mini|small/i.test(id)) ??
    models.find((id) => /sonnet/i.test(id)) ??
    models[0];
  settings.gatewaySearch ??= {};
  settings.gatewaySearch.model = `${name}/${chosen}`;
  writeJson(file, settings);
  console.log(`  search model: ${name}/${chosen}`);
}

async function configureResearch() {
  for (const provider of fs.readdirSync(path.join(here, "providers")).filter((f) => f.endsWith(".ts"))) {
    fs.mkdirSync(path.join(researchDir, "providers"), { recursive: true });
    fs.copyFileSync(path.join(here, "providers", provider), path.join(researchDir, "providers", provider));
  }
  console.log(`  wrote search providers to ${path.join(researchDir, "providers")}`);
  seed(config("deep-research.json"), path.join(researchDir, "config.json"));
  const chain = readJson(path.join(researchDir, "config.json")).value?.providers;
  if (Array.isArray(chain) && !chain.includes("gateway")) {
    console.warn(`  ${path.join(researchDir, "config.json")} has no "gateway" in "providers"; /research will not use the gateway`);
  }
  return;
}
