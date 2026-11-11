# Plan: pi-distro for a non-local gateway

Status: installed locally on this branch, and verified end to end against the
gateway. `web_search` / `web_extract` and `/research` both search through the
gateway via `providers/gateway.ts`; `multi-review` still loads and runs
unchanged. Everything else below is still the plan.

## Why this is a separate branch, not a flag

`main` inverts almost every design decision here, and rightly: it assumes a
local server (gufo) where prefill is the cost, sessions are scarce, and the
prompt head must never move.

On a hosted gateway the physics change. Prefill on a 1M-token model is
seconds, not minutes; prompt caching is automatic and cheap
(verified: cache read is 13x cheaper than a fresh input token on Anthropic,
16x on OpenAI Responses paths through the gateway); and there is no
`--sessions` ceiling to plan around. So the two branches optimize for
different things:

| | `main` (local) | `gateway` (this branch) |
|---|---|---|
| Binding constraint | prefill wall-clock, KV slots | token cost, wall-clock latency |
| Prompt head | must never change | change freely; cache absorbs it |
| Tool count | every tool costs prefill | tools are cheap; add what helps |
| Model choice | one local model | best model per role |
| Subagents | limited by `--sessions` | limited by rate limits and cost |

Keeping one config that switches on provider is worse than two branches: it
would carry assumptions from both and be honest about neither. `main` stays
the local distro; `gateway` becomes the hosted one.

## What is verified, not assumed

Probed live against the gateway, the same way the extension probes at runtime:

| API path | Model | Runs `web_search`? |
|---|---|---|
| `anthropic-messages` | Claude Opus / Sonnet / Haiku 5.5 | **yes** |
| `openai-responses` | gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna | **yes** |
| `openai-responses` | DeepSeek V4 Pro / V4.1 Flash, Gemini 3.8 Flash / 4 Argon, Grok 4.7, Kimi K3.1 Pro / K2.7 Code | **no** — accepts `tools`, ignores it |

That last row is the reason the extension probes instead of assuming. A model
that ignores the tool answers from memory and the answer looks normal. The
probe is a question only answerable by searching; whether the response carries
a `web_search_call` / `server_tool_use` block decides. Results cache in
`<agentDir>/gateway-search.json`, and a provider error is never cached, so a
brief gateway outage doesn't hide the tools for a week.

Also confirmed on the gateway: Anthropic serves `web_fetch_20250910`
separately from search (so `web_extract` reads pages directly), while the
Responses path has one tool that both searches and opens pages.

Consequence for the design: **search availability is per model, not per
provider.** Kimi K3.1 Pro is a strong reviewer but cannot search, so panels
that need search must not silently include it.

## Step 1 — Gateway provider config (done for dev, needs installer)

`config/models.template.json` currently writes a `gufo` provider. For this
branch the installer writes the gateway provider(s) from an endpoint plus a
key, and probes `/v1/models` where the gateway exposes it. Models are declared
with real costs so the footer, `/session`, and the reviewer picker show money
instead of zeros — which is the whole point of the cost discipline below.

## Step 2 — Prompt and tool loadout: invert the rule

`lean-prompt.ts` and `tool-loadout.ts` exist to shrink a prefix that is
expensive to reprocess. Here that pressure is gone, so:

- Keep the lean prompt (it is still better writing than a wall of boilerplate)
  but drop the "never touch the prompt head" rule and the cache-guard warnings
  that flow from it.
- Add tools that earn their place: `web_search`, `web_extract`,
  `multi_review`, subagents, plus `todo` and diagnostics.
- Drop `inference-stats.ts` and `cache-guard.ts` from the loadout: both read
  gufo's `/slots`, `/metrics` and `usage.gufo`, which do not exist here.
  Keep the *idea* of cache reporting via pi's own
  `showCacheMissNotices`, and keep `cache_warming_decision` if a provider
  declares `promptCache`.

## Step 3 — Web search (done, as a deep-research provider)

The first design registered `web_search` / `web_extract` in an extension.
That could not ship: **pi hard-errors when two extensions register the same
tool name** (`Tool "web_search" conflicts with ...` — verified), and
pi-deep-research always registers both. Since /research has to use the gateway
too, the extension was dropped and the gateway became pi-deep-research's
provider instead. One tool set, one code path, and `/research` plus the
`researcher` subagent both search through the gateway.

`providers/gateway.ts`:

- Implements pi-deep-research's `SearchProvider`: `search()` and `extract()`.
- Reads the gateway URL and key from `models.json` (with `$VAR` / `!command`
  resolved the way pi resolves them), so there is exactly one place to
  configure credentials.
- Probes whether the configured search model actually runs the provider's
  search tool, caching in `~/.pi/agent/gateway-search.json`. A model that
  ignores the tool is reported as unconfigured, so the chain moves on instead
  of passing a fabricated answer off as research.
- `models.json`'s gateway provider is reused when one already exists
  (`amd-gateway-anthropic` here) rather than adding a second name for one
  service; placeholder template URLs are never installed.
- The search model is written to `pi-distro.json` as `gatewaySearch.model`,
  picked from what is actually installed (Haiku over Opus: searching is cheap
  and high-volume).

Two gateway behaviours found while testing, both now handled:

- Anthropic's `web_fetch_20250910` reads pages; the Responses path's
  `open_page` fails with a DNS error on this gateway. So the Anthropic path is
  preferred, and `extract()` detects a model's "I couldn't read that page"
  reply and falls back to a plain HTTP read instead of handing the research
  agent a description of a failure as if it were the page.
- The Responses path needs the `/v1` root while Anthropic wants the API root;
  the endpoint builder supplies the version segment only where it is missing.

Deleted: `providers/searxng.ts`, `providers/exa-mcp.ts` and their tests. Both
exist on `main` to give a local model web access with no cloud account. Here
the gateway is the account, and a second vendor adds a rate limit rather than
removing one.

## Step 4 — Multi-review (port from pi-conf)

The existing `multi_review` extension in `~/Projects/pi-conf/multi-review`
already does multi-model review, Socratic discussion, verification rounds, PR
comment triage, and web search for reviewers. It needs four changes here:

1. **Ship it in the distro**, not as a symlink to a personal repo. Today it is
   `~/.pi/agent/extensions/multi-review -> ~/Projects/pi-conf/...`, which no
   one else can install. Vendor it under `extensions/multi-review/` (it is
   ~8.7k lines across `src/`, so this is a real decision, not a copy).
2. **Retarget web search** onto `gateway-search-api.ts`. The current
   `src/web-search.ts` already proxies through Haiku with `web_search` for
   models that can't search natively — that logic is right for this gateway
   and should become the *only* path, with `gateway-search.ts`'s probe cache
   reused instead of a second capability list.
3. **Fix the model pool to real capability.** `defaultThinkingLevel` and the
   reviewer pool should reflect the probe table: Kimi/Gemini/Grok review
   without search; Claude and GPT-6 family review with it. Reviews of code
   that depends on external APIs benefit from reviewers that can search.
4. **Update the import specifier.** `pi-conf`'s sources import
   `@mariozechner/pi-coding-agent`; pi 1.5 maps that alias, so it works, but
   new code should use `@earendil-works/pi-coding-agent`.

`multi-review.json` (reviewers, judge, thinking levels, `commentAuthors`) is
agent-directory config, so the installer seeds it like it seeds
`pi-distro.json` today.

## Step 5 — Subagents and deep research

- **Subagents**: `pi-lite-subagent` works unchanged; the model comes from
  agent frontmatter. On `main` the constraint is `PI_SUBAGENT_MAX_CONCURRENCY`
  matching gufo's `--sessions`. Here it should default higher (concurrency is
  a rate-limit question now) and the agents should name models: `explore` and
  `plan` on a fast cheap model, `reviewer` on a strong one, `researcher`
  needing a search-capable model.
- **Deep research**: `pi-deep-research` chains SearXNG → Exa → Tavily → Brave
  and its own approval flow. On this branch either (a) give it a provider
  plugin that calls `gateway-search-api.ts` and drop the rest, or (b) drop it
  and let `researcher` subagents plus `web_search` cover the same ground.
  (b) is less code and the gateway's answers are already sourced; (a) preserves
  `/research` habits. Recommend deciding by whether `/research` depth actually
  beats parallel `researcher` subagents on a real question — that is a one-hour
  experiment, and it is the same experiment that says whether `multi_review`'s
  Socratic mode is pulling its weight.

## Step 6 — Model routing (new capability, main cannot use)

Because the gateway exposes many models with real prices, a
`registerVirtualModel` router becomes worth having: a `auto` model that sends
continuation/retry requests to the model that already answered (keeping the
cache warm, per pi's virtual-model docs) and picks by task for new user turns.
`classify()` with a classifier model can drive this. This is the single
biggest token-cost lever available here and has no analogue on `main`.

Guards that matter more than the router itself:

- Never route a `continuation` to a different model — pi's docs are explicit
  that this loses the prompt cache.
- Route `retry` to a different model only on overload/context-overflow
  errors, which is exactly when switching pays.

## Step 7 — Costs you can see

The gateway returns `total_cost` per request (verified on both API paths), and
pi computes cost from `models.json` prices. So:

- Footer shows session cost, not tokens/s.
- A per-review cost line: `multi-review`'s pi-conf branch already added "report
  what each run actually cost" (commit `f46abb8`); carry that over.
- `/session` as the per-model breakdown.

## Step 8 — Features modern distros have that this one should consider

Surveyed the npm `pi-package` ecosystem plus what pi 1.5 now offers natively.
Ranked by value here, with what they cost:

| Candidate | Why it fits this branch | Cost |
|---|---|---|
| **Virtual-model router** (native) | Step 6; biggest cost lever | must write it |
| **`codemode` + `tool_search`** (native) | Frontier models write scripts well; hides a large MCP tool surface behind one declared tool. Directly replaces `main`'s "never change the tool list" rule with something better | small prompt cost, big capability gain |
| **MCP servers** (`builtin:mcp`) | Now cheap: `codemode`/`deferred` exposure keeps declarations stable | one config file |
| **Permission gate** (`examples/extensions/permission-gate.ts`) | On a hosted model the blast radius of a wrong `bash` call is unchanged; a confirm-on-destructive layer is cheap insurance | ~100 lines |
| **Ask-user question tool** (`@juicesharp/rpiv-ask-user-question`) | Typed options beat free-form guessing on ambiguous tasks | 1 package |
| **`pi-lens`** (LSP + linters + formatters) | Replaces `@ian-pascoe/pi-lsp` with something that also formats; big win with a strong model that can act on diagnostics | 1 package, token cost per edit |
| **Subagent workflows** (`pi-subagents`, `@quintinshaw/pi-dynamic-workflows`) | Scripted fan-out; the gateway can actually absorb the parallelism that `main` could not | 1 package |
| **Session search / memory** (`pi-memory`) | Long-lived projects; semantic recall across sessions | 1 package, needs an embedding path |
| **`/btw` side conversations** (`pi-btw`) | Ask a question without derailing the main task | 1 package |
| **Tracing** (`@braintrust/pi-extension`) | Only if the gateway work needs evals | credentials |
| **Plan review UI** (`@plannotator/pi-extension`) | Annotate a plan before it runs; better than text approval for big changes | 1 package |

Explicitly recommended *against*:

- Anything whose purpose is prompt compression on local models
  (`billion-context`, `context-mode`): prefill is not the constraint here.
- `pi-claude-bridge` (uses Claude Code as a provider): competes with the
  gateway this distro exists to use.
- Fifth and sixth reviewer vendors: the multi-review pool is already 4–5
  models; more seats cost more than they add once verification exists.

## Order of work

1. ~~`web_search` / `web_extract` on the gateway~~ (done, tested, probing)
2. ~~Provider config + installer for this branch~~ (done: `--gateway`,
   `--anthropic`, `--concurrency`; reuses an existing gateway provider)
3. ~~Web search via the gateway~~ (done: deep-research provider)
4. Loadout and prompt: drop `inference-stats`, `cache-guard`, plan-mode's
   gufo assumptions
5. Port `multi-review` into the distro (it is still a symlink to a personal
   repo) and retarget its reviewer search onto `providers/gateway.ts`
6. Subagent model assignment; concurrency default (now 4)
7. Virtual-model router with the cache-safety guards
8. Cost reporting in footer and review results
9. Only then: pick from the Step 8 table, one at a time, measuring each

## Open questions

- **Does the gateway's search bill per call or per token?** Not visible in the
  responses I probed. It decides whether `max_uses: 4` is generous or wasteful,
  and whether reviewers should search at all by default.
- **Prompt-cache TTL on the gateway.** Anthropic showed `ephemeral_5m`; the
  OpenAI path showed `cached_tokens` without a TTL. `promptCache` in
  `models.json` needs a real number before `cacheWarming` can be trusted.
- **Rate limits per model**, not per key — the probe showed 404s on a model
  that exists (a Responses-path routing quirk), so limits and routing failures
  need to be distinguished from "model can't search."
- **Which model is the default?** `main` defaults to a local Qwen. Here it is a
  cost/quality tradeoff with no obvious answer until Step 7 exists.
