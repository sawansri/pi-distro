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
import { catalogProviders, fetchCatalog, isPlaceholder } from "../extensions/catalog.ts";

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

/** Marks a frontmatter line this installer wrote, so a reinstall may revise it. */
const MARK = " # pi-distro";
const KEY_MARK = /\s#\s*pi-distro\s*$/;

const DEFAULT_AGENT_MODELS = {
  explore: { model: "DeepSeek-V4.1-Flash", thinking: "off" },
  plan: { model: "DeepSeek-V4.1-Flash", thinking: "high" },
  researcher: { model: "DeepSeek-V4.1-Flash", thinking: "medium" },
  reviewer: { model: "gpt-6.1-sol", thinking: "high" },
};

for (const agent of fs.readdirSync(path.join(here, "agents")).filter((f) => f.endsWith(".md"))) {
  seed(path.join(here, "agents", agent), target("agents", agent));
}
seed(config("pi-todo-config.json"), target("pi-todo", "config.json"));
configureDistro();
bindThinkingCycle();
// The top-level awaits run before the function declarations below are
// initialized as values, so nothing they call may sit in a `const` down there.
await configureModels();
configureSettings();
await configureResearch();
configureSearchModel();
assignAgentModels();

/** The provider that serves `id`, on a real endpoint, preferring a gateway provider. */
function providerFor(providers, id) {
  const serves = (name) => (providers[name]?.models ?? []).some((model) => model.id === id);
  const real = (name) => {
    const url = String(providers[name]?.baseUrl ?? "");
    return /^https?:\/\//.test(url) && !isPlaceholder(url);
  };
  const names = Object.keys(providers).filter(serves);
  return names.find((name) => name.startsWith("gateway") && real(name)) ?? names.find(real) ?? names[0];
}

/**
 * Writes each agent's `model:`/`thinking:` from pi-distro.json or the defaults.
 *
 * Two rules, both learned the hard way:
 * - A model the user chose is kept. `agentModels` in pi-distro.json wins over
 *   the defaults, and a `model:` line already in the file wins over both, so
 *   re-running the installer never undoes a deliberate choice.
 * - Every existing `model:`/`thinking:` line is removed, whatever its spacing
 *   or value. Leaving an empty `model:` behind while appending a second one
 *   makes the frontmatter unparseable, and pi-lite-subagent then drops the
 *   agent entirely instead of reporting a bad file.
 *
 * The provider name is resolved here rather than written into the .md files:
 * configureModels reuses an existing provider for the same endpoint, so the name
 * differs between installs and a hard-coded one would point at nothing.
 */
function assignAgentModels() {
  const settings = mergeTarget(target("pi-distro.json"));
  if (!settings) return;
  const providers = readJson(target("models.json")).value?.providers ?? {};
  const overrides = settings.agentModels ?? {};
  const wanted = { ...DEFAULT_AGENT_MODELS, ...overrides };
  const assigned = [];
  for (const [agent, choice] of Object.entries(wanted)) {
    const file = target("agents", `${agent}.md`);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // A role the user deleted stays deleted.
    }
    const id = typeof choice === "string" ? choice : choice?.model;
    const provider = id ? providerFor(providers, id) : undefined;
    if (!provider) continue;
    const thinking = (typeof choice === "object" ? choice.thinking : undefined) ?? DEFAULT_AGENT_MODELS[agent]?.thinking;
    // Frontmatter is the first `---` line to the next one; tolerate CRLF and BOM.
    const lines = text.split(/\r?\n/);
    const end = lines.indexOf("---", 1);
    if (lines[0].replace(/^\ufeff/, "") !== "---" || end === -1) continue;
    // Indentation is legal YAML, so match keys at any depth.
    const keyOf = (line) => line.match(/^\s*(model|thinking)\s*:/)?.[1];
    const valueOf = (line) => {
      const raw = line.replace(/^\s*(model|thinking)\s*:/, "");
      // A trailing comment leaves the value empty in YAML.
      return raw.replace(/(^|\s)#.*$/, "").trim();
    };
    const existing = lines.slice(1, end);
    // A value this installer wrote carries a trailing marker, so a later run
    // can revise its own choice without touching one the user typed.
    const ours = (line) => KEY_MARK.test(line);
    const mine = existing.filter((line) => keyOf(line) === "model");
    // A value the user typed outranks both agentModels and the defaults.
    const userSet = mine.some((line) => valueOf(line) !== "" && !ours(line));
    if (userSet && !overrides[agent]) continue;
    const frontmatter = existing.filter((line) => !keyOf(line));
    frontmatter.push(`model: ${provider}/${id}${MARK}`);
    if (thinking) frontmatter.push(`thinking: ${thinking}${MARK}`);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const bom = lines[0].startsWith("\ufeff") ? "\ufeff" : "";
    fs.writeFileSync(file, [bom + "---", ...frontmatter, ...lines.slice(end)].join(eol));
    assigned.push(`${agent} → ${id}`);
  }
  if (assigned.length > 0) console.log(`  subagent models: ${assigned.join(", ")}`);
}

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

/** Adds the gateway providers to models.json: from the live catalogue when it answers, else the template. */
async function configureModels() {
  const file = target("models.json");
  const current = mergeTarget(file);
  if (!current) return;
  current.providers ??= {};
  const template = readJson(config("models.template.json")).value.providers ?? {};
  const overrides = { gateway: args.gateway, "gateway-anthropic": args.anthropic };
  // The Anthropic path is served from the gateway root, e.g. `.../Unified`
  // where the OpenAI paths live at `.../Unified/v1`, so --gateway alone also
  // points the Anthropic provider. Without this, --gateway left the Anthropic
  // models on the template's placeholder URL and skipped them.
  if (!overrides["gateway-anthropic"] && overrides.gateway) {
    overrides["gateway-anthropic"] = overrides.gateway.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  // The gateway publishes each model's price and the API it is served on. Use
  // them when it answers: the template is a fallback that can go stale, and a
  // stale price is wrong money in the footer, not a cosmetic detail.
  const gatewayUrl = (overrides.gateway ?? template.gateway?.baseUrl ?? "").replace(/\/+$/, "");
  const probeProvider = template["gateway-anthropic"] ?? template.gateway ?? {};
  const { entries: catalog, error } = await fetchCatalog(gatewayUrl, probeProvider);
  const providers = catalog ? catalogProviders(catalog, template, overrides) : template;
  if (catalog) {
    const count = Object.values(providers).reduce((total, spec) => total + spec.models.length, 0);
    console.log(`  gateway catalogue: ${count} models with the gateway's own prices`);
  } else if (process.env.PI_DISTRO_NO_CATALOG) {
    console.log("  gateway catalogue: skipped (PI_DISTRO_NO_CATALOG)");
  } else {
    console.log(`  gateway catalogue unavailable (${error}); using the template's model list`);
  }
  let added = 0;
  for (const [name, spec] of Object.entries(providers)) {
    const existing = current.providers[name];
    const baseUrl = (overrides[name] ?? existing?.baseUrl ?? spec.baseUrl).replace(/\/+$/, "");
    // The template's own placeholder URL is not a gateway: adding it would leave
    // a provider that always fails. An endpoint given on the command line is
    // never a placeholder, whatever its host looks like.
    const placeholder = overrides[name] === undefined && isPlaceholder(baseUrl);
    if (!existing) {
      if (placeholder) {
        console.log(`  ${name}: no gateway URL given, not adding a placeholder provider`);
        continue;
      }
      // Reuse a provider the user already has for the same endpoint instead of
      // adding a second name for one service (amd-gateway, say). Only within one
      // API family: the OpenAI and Anthropic paths can share a base URL, and
      // reusing across them would drop a whole family's models.
      const family = (api) => (api === "anthropic-messages" ? "anthropic" : "openai");
      const endpointOf = (provider) => String(provider?.baseUrl ?? "").replace(/\/+$/, "");
      const twin =
        Object.entries(current.providers).find(
          ([, provider]) =>
            (provider?.models ?? []).length > 0 &&
            endpointOf(provider) === baseUrl &&
            family(provider?.api) === family(spec.api),
        ) ??
        // Any real provider in this API family already is the gateway -- but
        // only when no endpoint was named at all: otherwise an unrelated
        // provider (api.openai.com) would silently swallow the gateway.
        (overrides[name] === undefined && !overrides.gateway && !overrides["gateway-anthropic"]
          ? Object.entries(current.providers).find(
              ([, provider]) =>
                (provider?.models ?? []).length > 0 &&
                family(provider?.api) === family(spec.api) &&
                !isPlaceholder(provider?.baseUrl),
            )
          : undefined);
      if (twin) {
        console.log(`  ${name}: using the existing ${twin[0]} provider`);
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
  // A model counts as search-capable by its own api, which is where the gateway
  // catalogue records it; the provider's api is only the default.
  const searchApi = (provider, model) =>
    ["anthropic-messages", "openai-responses"].includes(model.api ?? provider.api);
  const searchable = withModels.filter(([, provider]) => (provider.models ?? []).some((model) => searchApi(provider, model)));
  // Keep a default that still resolves. A provider missing from models.json is
  // a built-in (anthropic, openai) whose models this file knows nothing about,
  // so it is left alone; only a provider defined here can be shown to be stale.
  const resolves = () => {
    const provider = providers[settings.defaultProvider];
    if (!provider) return true;
    return (provider.models ?? []).some((model) => model.id === settings.defaultModel);
  };
  const hasDefault =
    typeof settings.defaultProvider === "string" && settings.defaultProvider !== "gufo" && resolves();
  const [name, provider] = (searchable.length > 0 ? searchable : withModels)[0] ?? [];
  if (name && !hasDefault) {
    const capable = provider.models.filter((model) => searchApi(provider, model));
    // A capable, mid-priced model rather than whichever happens to be listed
    // first: the template lists the most expensive one first, and defaulting to
    // it is a silent way to overspend.
    const first =
      capable.find((model) => /\b(sonnet|sol|terra)\b/i.test(model.id)) ?? capable[0] ?? provider.models[0];
    settings.defaultProvider = name;
    settings.defaultModel = first.id;
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

/**
 * Point the gateway search provider at a model this install actually has.
 *
 * Search needs a model on an API that runs a server-side search tool, and the
 * cheapest one is the best default: searching is a high-volume, low-thinking
 * call. A model already configured is kept when it still resolves, so a user who
 * had to move off a model that cannot search does not get moved back on every
 * reinstall.
 */
function configureSearchModel() {
  const file = target("pi-distro.json");
  const settings = mergeTarget(file);
  if (!settings) return;
  const providers = readJson(target("models.json")).value?.providers ?? {};
  // Per-model `api` overrides the provider's, so rank the models themselves.
  const searchable = [];
  for (const [name, provider] of Object.entries(providers)) {
    if (!/^https?:\/\//.test(String(provider?.baseUrl ?? "")) || isPlaceholder(provider.baseUrl)) continue;
    for (const model of provider.models ?? []) {
      const api = model.api ?? provider.api;
      if (api === "anthropic-messages") searchable.push({ name, id: model.id, rank: 0 });
      else if (api === "openai-responses") searchable.push({ name, id: model.id, rank: 1 });
    }
  }
  if (searchable.length === 0) {
    console.warn("  no gateway model with a search-capable api; web search and /research will have no backend");
    return;
  }
  const configured = settings.gatewaySearch?.model;
  if (typeof configured === "string" && searchable.some((m) => `${m.name}/${m.id}` === configured)) {
    console.log(`  search model: ${configured} (kept)`);
    return;
  }
  searchable.sort((a, b) => a.rank - b.rank);
  // Haiku before Sonnet before Opus; Flash/Mini before the rest.
  const preferred =
    // Whole words only: `mini` matches "Gemini" and `flash` matches
    // "DeepSeek-V4.1-Flash", and neither is a cheap search model.
    searchable.find((m) => /\b(haiku|flash-lite|nano|small)\b/i.test(m.id)) ??
    searchable.find((m) => /\b(haiku)\b/i.test(m.id)) ??
    searchable.find((m) => /\b(mini)\b/i.test(m.id)) ??
    searchable.find((m) => /\bflash\b/i.test(m.id)) ??
    searchable.find((m) => /sonnet/i.test(m.id)) ??
    searchable[0];
  settings.gatewaySearch ??= {};
  settings.gatewaySearch.model = `${preferred.name}/${preferred.id}`;
  writeJson(file, settings);
  console.log(`  search model: ${preferred.name}/${preferred.id}`);
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
