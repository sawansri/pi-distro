/**
 * Turning a gateway's model catalogue into `models.json` entries.
 *
 * Shared by the installer (`scripts/configure.mjs`) and the `/models-refresh`
 * command (`extensions/models-refresh.ts`), so both agree on what a model entry
 * should look like and neither duplicates the reasoning below.
 *
 * Nothing here reads the filesystem or the environment: callers pass the
 * catalogue and the config in.
 */

/** The template's documentation host, which is never a real gateway. */
const TEMPLATE_HOSTS = new Set(["llm-api.example.com"]);

/** Whether a URL is the template's placeholder rather than a gateway. */
export function isPlaceholder(url) {
  try {
    return TEMPLATE_HOSTS.has(new URL(String(url)).hostname);
  } catch {
    return false; // Not a URL at all: "no endpoint", reported elsewhere.
  }
}

/**
 * The `api` a gateway model must be declared with.
 *
 * This matters more than it looks: a model sent to an API it isn't served on
 * does not fail. The gateway accepts the request and answers from an unpinned
 * default pool, and bills it under the name that was asked for — so a wrong
 * `api` silently tests one model and ships another's answers, with cache and
 * cost numbers that belong to yet another one. Measured on a real gateway
 * 2026-11-11: DeepSeek and Kimi, which the catalogue lists as
 * `responses: false`, answered on the Responses path anyway and reported
 * `model: "default"`.
 */
export function servedApi(entry) {
  if (entry?.capabilities?.chat !== true) return undefined;
  if (/anthropic/i.test(entry.owned_by ?? "")) return "anthropic-messages";
  return entry.capabilities?.responses === true ? "openai-responses" : "openai-completions";
}

/**
 * One `models.json` entry, carrying the catalogue's price and limits.
 *
 * Prices are per million tokens, as the gateway publishes them, so the footer
 * and `/session` show what will be billed rather than a hand-kept guess.
 */
export function catalogModel(entry) {
  const pricing = entry.pricing ?? {};
  const perMillion = (value) => (typeof value === "number" && value > 0 ? value : 0);
  const contextWindow = entry.context_length || 128000;
  const model = {
    id: entry.id,
    name: entry.id,
    reasoning: !/(chat|realtime)$/i.test(entry.id),
    input: entry.capabilities?.vision ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens: Math.min(entry.max_output_tokens || 16384, contextWindow),
    cost: {
      input: perMillion(pricing.input_per_million),
      output: perMillion(pricing.output_per_million),
      cacheRead: perMillion(pricing.cache_read_input_per_million),
      cacheWrite: perMillion(pricing.cache_creation_input_per_million),
    },
  };
  // pi warms only the cache tiers a model declares a lifetime for, and a
  // declared lifetime it doesn't have costs real money in refresh requests.
  const longLived = perMillion(pricing.cache_creation_1h_per_million) > 0;
  if (model.cost.cacheRead > 0 || longLived) model.promptCache = {};
  if (model.promptCache) {
    if (model.cost.cacheRead > 0) model.promptCache.short = 300;
    if (longLived) model.promptCache.long = 3600;
  }
  return model;
}

/**
 * The providers, with every catalogue model filed under the API it is served
 * on.
 *
 * The two OpenAI paths share one endpoint and one credential, so they share one
 * provider and differ per model. The Anthropic path has its own root URL, which
 * is derived from the OpenAI one when the caller didn't give it: `.../Unified`
 * where the OpenAI paths live at `.../Unified/v1`.
 */
export function catalogProviders(
  entries,
  template,
  overrides,
) {
  const providers = {};
  const root = (url) => url?.replace(/\/+$/, "").replace(/\/v1$/, "");
  const anthropicUrl =
    overrides["gateway-anthropic"] ?? root(overrides.gateway) ?? root(template["gateway-anthropic"]?.baseUrl);
  for (const entry of entries) {
    const api = servedApi(entry);
    if (!api) continue;
    const openai = api !== "anthropic-messages";
    const name = openai ? "gateway" : "gateway-anthropic";
    if (!providers[name]) {
      const base = template[name] ?? {};
      providers[name] = {
        ...base,
        api: openai ? "openai-completions" : api,
        models: [],
        baseUrl: overrides[name] ?? (openai ? base.baseUrl : anthropicUrl),
      };
    }
    const model = catalogModel(entry);
    // A per-model api overrides the provider's, which is the common path here.
    if (openai) model.api = api;
    providers[name].models.push(model);
  }
  return providers;
}

/** Resolve `$VAR` / `${VAR}` the way pi does for models.json values. */
export function resolveValue(raw, env = process.env) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\$\$|\$!|\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => {
    if (match === "$$") return "$";
    if (match === "$!") return "!";
    return env[braced ?? bare] ?? "";
  });
}

/**
 * The headers a request to `baseUrl` needs, from a models.json provider.
 *
 * The bearer token is added only when the provider declares none, so a gateway
 * that wants its own header (`Ocp-Apim-Subscription-Key`, say) gets exactly
 * what `models.json` says and nothing extra.
 */
export function authHeaders(provider, env = process.env) {
  const out = { "content-type": "application/json" };
  for (const [header, value] of Object.entries(provider?.headers ?? {})) {
    const resolved = resolveValue(value, env);
    if (resolved) out[header] = resolved;
  }
  const has = (name) => Object.keys(out).some((key) => key.toLowerCase() === name);
  const key = resolveValue(provider?.apiKey, env);
  if (key && !has("authorization") && !has("x-api-key") && !/anthropic/i.test(provider?.api ?? "")) {
    out.authorization = `Bearer ${key}`;
  }
  return out;
}

/**
 * Fetch `<baseUrl>/models` from a gateway.
 *
 * Optional by design: the gateway is the user's, not ours, so this is the only
 * request the distro makes to it on its own initiative, and every failure (no
 * key, no route, a slow server, an endpoint that publishes no catalogue) is
 * reported as "no catalogue" rather than thrown. `PI_DISTRO_NO_CATALOG=1`
 * skips it entirely, for an offline or air-gapped install.
 */
/**
 * The header name a 401 says it wanted, from `www-authenticate`.
 *
 * APIM advertises `name="Ocp-Apim-Subscription-Key"`, and a proxy that wants its
 * own header usually does the same. Reading it means a gateway with a
 * non-standard scheme works without hand-editing the template first.
 */
export function advertisedHeader(response) {
  const value = response?.headers?.get?.("www-authenticate") ?? "";
  const name = /name="([^"]+)"/.exec(value)?.[1];
  // Only a plain header name, so a crafted header cannot inject another header.
  return name && /^[A-Za-z0-9-]+$/.test(name) ? name : undefined;
}

/**
 * Fetch `<baseUrl>/models` from a gateway.
 *
 * Optional by design: the gateway is the user's, not ours, so this is the only
 * request the distro makes to it on its own initiative, and every failure (no
 * key, no route, a slow server, an endpoint that publishes no catalogue) is
 * reported as "no catalogue" rather than thrown. `PI_DISTRO_NO_CATALOG=1`
 * skips it entirely, for an offline or air-gapped install.
 */
export async function fetchCatalog(baseUrl, provider, env = process.env, timeoutMs = 3000) {
  if (env.PI_DISTRO_NO_CATALOG) return { error: "catalogue fetching disabled by PI_DISTRO_NO_CATALOG" };
  if (!/^https?:\/\//.test(baseUrl ?? "") || isPlaceholder(baseUrl)) {
    return { error: "no gateway endpoint configured" };
  }
  const headers = authHeaders(provider, env);
  const key = resolveValue(provider?.apiKey, env);
  if (!key && !Object.keys(headers).some((h) => /authorization|api-key/i.test(h))) {
    return { error: "no API key configured for the gateway" };
  }
  const read = async (response) => {
    if (!response.ok) return { error: `gateway answered ${response.status} to /models` };
    const body = await response.json();
    const entries = Array.isArray(body?.data) ? body.data : undefined;
    return entries && entries.length > 0 ? { entries } : { error: "the gateway published no models" };
  };
  try {
    const first = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (first.ok) return read(first);
    // A 401 that names the header it wants: send that and try once more. This is
    // what makes the template vendor-neutral without losing the catalogue on a
    // gateway that uses a subscription key.
    const wanted = first.status === 401 ? advertisedHeader(first) : undefined;
    if (!wanted || !key) return { error: `gateway answered ${first.status} to /models` };
    const retry = await fetch(`${baseUrl}/models`, {
      headers: { ...headers, [wanted]: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return read(retry);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The model entries a provider should have after a refresh.
 *
 * The catalogue is authoritative for the IDs it lists, so those entries are
 * replaced (a stale price is the whole reason to refresh). Every other entry in
 * the provider is kept by default: the catalogue cannot tell a model the gateway
 * retired from one the user added by hand, and deleting a working model is worse
 * than carrying a dead one for a while. `prune` drops them, for when the user
 * knows the catalogue is the whole truth.
 */
export function mergeModels(existing, catalogModels, prune = false) {
  if (prune) return [...catalogModels];
  const listed = new Set(catalogModels.map((model) => model.id));
  return [...catalogModels, ...existing.filter((model) => !listed.has(model.id))];
}
