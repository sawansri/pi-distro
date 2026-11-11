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

Everything below was measured against the live gateway on 2026-11-11, not read
from documentation.

| API path | Model | Runs `web_search`? |
|---|---|---|
| `anthropic-messages` | Claude Opus / Sonnet / Haiku 5.5 | **yes** |
| `openai-responses` | gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, GPT-6.1-Terra | **yes** |
| `openai-completions` | every other chat model | **no** — that API has no server-side search tool |

An earlier version of this table listed DeepSeek, Gemini, Grok and Kimi under
`openai-responses` as accepting `tools` but ignoring it. Re-probed on
2026-11-11, that was measuring the wrong thing: the gateway catalogue reports
those models as `responses: false` (`capabilities.responses` in `/v1/models`),
and **sending one to `/v1/responses` does not fail**. The gateway accepts the
request and answers from an unpinned default pool, then bills it at the asked
model's rates. A 15k-token prompt billed $0.000137 on `/v1/responses` where the
same prompt on `/v1/chat/completions` billed $0.0038 — the Responses answer was
not that model at all, and its `model` field read `"default"`.

So the capability question is not "does this model search" but "which API is
this model served on", and the installer now records that per model from the
catalogue (`api` on each entry). Chat Completions models genuinely cannot
search, which is why the search model is chosen from the two APIs above.

The extension still probes: a model can be on a search-capable API and still
fail to run the tool. The probe is a question only answerable by searching, and
whether the response carries a `web_search_call` / `server_tool_use` block
decides. Results cache in `<agentDir>/gateway-search.json`, keyed by endpoint as
well as model, and neither a provider error nor an auth failure is cached, so a
brief outage or an unset key doesn't hide the tools for a week.

Also confirmed on the gateway: Anthropic serves `web_fetch_20250910`
separately from search (so `web_extract` reads pages directly), while the
Responses path has one tool that both searches and opens pages.

Consequence for the design: **search availability is per model and per API.**
A reviewer that cannot search must not be silently included in a panel that
needs search.

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

- **Subagents**: `@tintinweb/pi-subagents`, with the model from agent
  frontmatter. `pi-lite-subagent` was the first choice and was replaced once it
  became clear the other already ships the live widget, FleetView and
  per-agent conversation viewer — the hand-written panel was deleted rather
  than maintained (`git show 6531773:extensions/subagent-view.ts`). Concurrency
  is `maxConcurrent` in `subagents.json`; two pools, background and foreground,
  so `--concurrency` sets both.
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

## Cost and cache, measured

These numbers came out of the gateway's own `usage` blocks and changed the
design, so they are recorded rather than assumed.

- **`/v1/models` publishes every model's price**, per million tokens, including
  `cache_read_input_per_million` and `cache_creation_input_per_million`. The
  installer now reads them, so `models.json` matches the bill. The hand-written
  template it replaced had Haiku 5.5 at 8x its real input price and Opus 5.5 at
  ~4x, among others.
- **Prompt caching is on by default and pays across deployments.** The same
  15k-token prompt on `DeepSeek-V4.1-Flash` billed $0.0038 cold and $0.00014
  warm; on `gpt-6-luna`, $0.00128 cold and $0.000108 warm. The gateway
  load-balances across two Azure deployments behind the gateway, and the
  cached prefix survives the switch between them.
- **The Anthropic path reports cache writes explicitly**
  (`cache_creation.ephemeral_5m_input_tokens`) and honours `cache_control`
  breakpoints: a marked system block wrote 36k tokens once, then read them back
  at 13x cheaper on the next call.
- **A wrong `api` silently tests a different model** — see the table above. This
  is the single most important thing the installer gets right.
- **`x-token-usage-cost` is in every response header**, and both API paths also
  return `total_cost` in `usage`. pi ignores both and computes cost from
  `models.json`, which is why the generated prices matter as much as they do.

## Order of work

1. ~~`web_search` / `web_extract` on the gateway~~ (done, tested, probing)
2. ~~Provider config + installer for this branch~~ (done: `--gateway`,
   `--anthropic`, `--concurrency`; generates from the live catalogue; reuses an
   existing provider for the same endpoint within one API family)
3. ~~Web search via the gateway~~ (done: deep-research provider)
4. ~~Loadout: drop `inference-stats`~~ (done; it polls gufo's `/slots`)
5. ~~Subagent model assignment; concurrency default 4~~ (done: per-role models
   written by the installer, provider name resolved at install time)
6. ~~`cache-guard` on the gateway's APIs~~ (done: it only understood
   chat-completions `messages`, so it was a silent no-op on both paths here)
7. Port `multi-review` into the distro (it is still a symlink to a personal
   repo) and retarget its reviewer search onto `providers/gateway.ts`
8. Virtual-model router with the cache-safety guards — **now questionable**;
   see the router note below
9. Cost reporting: largely done by the price fix plus pi's own footer; add a
   per-review cost line when `multi-review` lands
10. Only then: pick from the Step 8 table, one at a time, measuring each

## Cheap subagent models: measured, not assumed

The cheap roles default to DeepSeek V4.1 Flash. It was chosen over `gpt-6-luna`
on **speed**, which is the constraint the token price does not describe. Measured
against the live gateway on 2026-11-11, 3 runs each, median, ~4k-token prompt:

| Model | TTFT | wall (300 out) | decode | input $/1M |
|---|---|---|---|---|
| DeepSeek-V4.1-Flash | 771ms | 2.18s | 213 tok/s | 0.255 |
| gpt-6-luna | 1301ms | 4.46s | 95 tok/s | 0.068 |

DeepSeek is **2.2x faster** and **3.7x more expensive**. At subagent volumes the
price difference is cents, and the wall-clock difference is the whole experience,
so the faster model wins. Luna remains the cheaper option if throughput ever
becomes the binding cost.

Adequacy was checked rather than assumed: both models located the plan-mode
allowlist by `path:line` correctly, but DeepSeek quoted the exact table, named the
`GIT_UNSAFE` lookahead and the locale-only env rule, and was **2-6x faster** doing
it. Every line it cited was verified against the source, and it correctly flagged
a second agent's off-by-three line reference.

Because the cheap tier is cheap, the agent prompts no longer trade thoroughness
for tokens: `explore` reads whole files when the answer needs them, and
`researcher` runs as many queries as the question needs. The one cap kept is the
400-word report length, which protects the *parent's* context rather than the
wallet — the parent is an expensive model and pays for every word.

## Sandboxing: what was measured, and the trap

Three options were tested on this machine rather than compared from docs.

| | nono (Landlock) | pi-sandbox (bwrap) | guard (ours) |
|---|---|---|---|
| Runs with `CapEff: 0` | **yes** (ABI 8) | **no** — `bwrap: Failed RTM_NEWADDR` | yes |
| Blocks reading `~/.ssh` | **yes** | via bwrap | pattern only |
| Blocks network by default | **yes** (denied the gateway until allowed) | via bwrap | no |
| Interactive prompts | none | **prompts per blocked call** | none |

`pi-sandbox` is dropped. It is built on `@carderne/sandbox-runtime`, which uses
`bwrap` on Linux, and this environment has no effective capabilities — so it
cannot start. Its own README also notes that glob patterns in
`allowWrite`/`denyWrite` are **silently ignored on Linux**, so such a config
looks protective without being it.

nono is kept, via `scripts/sandbox.sh`. Two things it needs that are not
obvious, both found by running it: `~/.gitconfig` must be granted read-only or
every `git` command dies, and `/tmp` must be writable or jiti cannot compile
extensions and pi fails to load them.

**The trap worth recording.** The first version of the launcher granted
`--read ~/.ssh` so that `git push` over SSH would work. That grant makes private
keys readable to the agent — verified: without it `head -c 4 ~/.ssh/id_ed25519`
returns `Permission denied`, with it the read succeeds. It re-opened the exact
hole the sandbox exists to close, and the fix is to leave pushing to the human.
`test/guard.test.ts` now fails if the launcher ever grants `~/.ssh` again.

**Why the guard is still needed.** nono let `git push --force` through, correctly:
a force-push is a local git operation plus an allowed domain, and a filesystem
sandbox has nothing to object to. The guard blocks it. In the other direction,
the guard saw `./build.sh` as an ordinary workspace file; nono refused the
`cat ~/.ssh` inside it at the syscall. Each catches what the other cannot see.

## The router: what the evidence says now

Step 6 proposed a virtual-model router as "the single biggest token-cost lever".
Published results suggest that is true for **per-thread** routing and mostly
false for **per-turn** routing:

- LangChain's harness router cut median cost 64% ($2.61 → $0.94) and matched
  quality, with the model **fixed for the whole thread**.
- Their honest negative result: with 93% of turns sent to a small model, 7% of
  calls were 68% of the bill, and routing did not clearly beat just using the
  cheap model (the gain was inside the error bars).
- Switching models mid-conversation invalidates the prompt cache and breaks
  reasoning signatures; Anthropic's own guidance is to pick model and effort at
  session start. A classifier call is not free either: Switchyard measured its
  judge at 21% of routed spend and ~700ms per turn.

So the cheap version of this step is the one already implemented: **static
per-role assignment** (`agentModels`), where each subagent is a fresh thread
with its own cache and the main loop never switches. A cache-warming,
conversation-sticky router is worth building only if a per-thread experiment
shows the role split is not capturing most of the saving.

## Open questions

- **Does the gateway's search bill per call or per token?** The Anthropic path
  reports `server_tool_use.web_search_requests` in `usage`, so the count is
  visible; the price is not itemised. It decides whether `max_uses: 4` is
  generous or wasteful.
- **Prompt-cache TTL on the gateway.** Anthropic's catalogue entry prices a 1h
  tier (`cache_creation_1h_per_million`) and `ephemeral_1h` is accepted, but no
  response has yet shown a 1h write, so `promptCache.long` is only declared for
  models that price it. The OpenAI path reports `cache_write_tokens` with no
  TTL, so only `promptCache.short` is declared there.
- **Rate limits per model**, not per key. Neither API documents a limit in the
  catalogue beyond a `capacity` string ("15M TPM, 15K RPM").
- **Which model is the default?** Currently the first search-capable model of
  the preferred provider. That is a placeholder for a real cost/quality choice.
