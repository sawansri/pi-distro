# pi-distro

A [pi](https://pi.dev) distro for hosted models behind an LLM gateway.

It aims to make a fleet of models feel like one: a cheap model where the work is
shallow, a strong one where it matters, the price of every request visible, and
web search that actually searches.

The local-model distro lives on `main`; this branch assumes a gateway that serves
many models over one credential (Azure OpenAI, Anthropic, Vertex, on-prem).

## Install

```sh
git clone https://github.com/sawansri/pi-distro && cd pi-distro
export LLM_GATEWAY_KEY=...                     # the gateway's key
./install.sh --gateway https://llm-api.example.com/Unified/v1
pi
```

- `--gateway <url>`: the gateway's OpenAI-compatible endpoint, usually `.../v1`.
  The installer asks it for `/v1/models` and writes a provider per API, with the
  gateway's own prices. The Anthropic path is derived from this URL when you
  don't pass `--anthropic`.
- `--anthropic <url>`: the gateway's Anthropic-compatible root (no `/v1`), if it
  is not the `--gateway` URL with the version segment removed.
- `--concurrency <n>`: how many subagent tasks run at once (default 4).
- `--dir <path>`: install into a separate agent directory and start pi with
  `PI_CODING_AGENT_DIR=<path> pi`.
- `--dev`: load the extensions from this clone, so edits apply in the next session.

The installer installs pi if needed, then the pinned packages in
`config/packages.txt`. It creates config files only where none exist and merges
into the ones you have. Language servers found on `PATH` are configured for
diagnostics after edits.

## The only request the installer makes

The installer reads `<gateway>/models` once, from the endpoint you passed, to
learn each model's price and which API serves it. That is the *only* network
call it makes to your gateway, it has a 3-second timeout, and every failure
(no key, no route, a slow server, a gateway that publishes no catalogue) falls
back to `config/models.template.json` and still produces a working install.

To make no request at all — offline, air-gapped, or a metered link — set:

```sh
PI_DISTRO_NO_CATALOG=1 ./install.sh --gateway https://your-gateway/v1
```

`/models-refresh` does the same thing later, on demand:

| Command | What it does |
|---|---|
| `/models-refresh` | re-read the catalogue from the endpoint in `models.json` and update prices, limits and newly added models |
| `/models-refresh --prune` | the same, but also drops entries the gateway no longer lists |

It only rewrites the distro's own providers (`gateway`, `gateway-*`) on a real
endpoint, keeps any model you added by hand unless you pass `--prune`, writes
nothing when nothing changed, and leaves the file untouched when the fetch
fails. pi reads `models.json` at startup and `/reload` does not cover it, so
restart afterwards.

### If your gateway wants its own auth header

The template sends a bearer token, which most gateways accept. Azure API
Management and some enterprise proxies want a subscription-key header instead,
and they say so: a `401` carries

```
www-authenticate: AzureApiManagementKey realm="…",name="Ocp-Apim-Subscription-Key",type="header"
```

The catalogue request reads that name and retries with it, so a neutral template
still gets the gateway's own prices — no edit needed. Setting the header
explicitly works too, and is worth doing if you want it visible in `models.json`:

```json
"headers": { "Ocp-Apim-Subscription-Key": "$LLM_GATEWAY_KEY" }
```

## What the installer works out for you

**The model catalogue.** The gateway publishes each model's price, context
window, and which API serves it. `models.json` is generated from that, so the
footer and `/session` show what will be billed instead of a stale guess.

**Which API each model is on.** This is not cosmetic. A model sent to an API it
is not served on does not fail here: the gateway answers from an unpinned
default pool and bills it under the name you asked for, so the answer you get is
not the model you chose. The installer records the API per model from the
catalogue's own `capabilities`, and nothing else should route around it.

**Who does which job.** Each subagent gets a model in its frontmatter:

| Agent | Model | Why |
|---|---|---|
| explore | DeepSeek V4.1 Flash | 213 tok/s and 0.8s TTFT, measured; accuracy checked on real tasks |
| plan | DeepSeek V4.1 Flash, high thinking | reading and reasoning, no tool depth |
| researcher | DeepSeek V4.1 Flash | searching, summarising |
| reviewer | gpt-6.1-sol | catches what the author's family misses |
| general-purpose | the session's model | it does what you already chose a model for |

The cheap tier is chosen for **speed, not price**: luna is 3.7x cheaper per token
but 2.2x slower, and at subagent volumes the price gap is cents while the latency
is the whole experience. `PLAN-gateway.md` records the measurement.

Change them in `pi-distro.json` under `agentModels`, e.g.
`{"reviewer": {"model": "Claude-Opus-5-5", "thinking": "high"}}`; the installer
rewrites its own lines on the next run and leaves lines you typed alone.

## What you get

| Feature | Provided by | Use |
|---|---|---|
| Deep research with sources | [pi-deep-research](https://github.com/czhiming-maker/pi-deep-research), with `providers/gateway.ts` | `/research [quick\|standard\|deep] <topic>`, or ask |
| Web search and page reading | pi-deep-research's `web_search` and `web_extract`, through the gateway's own search tool | automatic; no SearXNG or API key of its own |
| Plan mode, no extra tools | `extensions/plan-mode.ts` | `shift+tab`, `/plan` |
| Subagents | [pi-lite-subagent](https://www.npmjs.com/package/pi-lite-subagent), `agents/` | explore, plan, reviewer, researcher, general-purpose |
| Todo list | [pi-todo-lite](https://www.npmjs.com/package/pi-todo-lite) | `ctrl+alt+t`, `/todos` |
| Diagnostics after edits | [@ian-pascoe/pi-lsp](https://www.npmjs.com/package/@ian-pascoe/pi-lsp) | automatic; its tools are off |
| Undo file changes | [pi-workspace-history](https://www.npmjs.com/package/pi-workspace-history) | `/undo`, `/redo`, `/diff` |
| AGENTS.md in subdirectories | [pi-subdir-context](https://www.npmjs.com/package/pi-subdir-context) | automatic, on read |
| Compaction from the prompt cache | [pi-cached-compaction](https://www.npmjs.com/package/pi-cached-compaction) | automatic, `/compact` |
| Cache hit rate and miss warnings | `extensions/cache-guard.ts` | footer; warns with the cause |
| Refresh the model list | `extensions/models-refresh.ts` | `/models-refresh [--prune]` |
| Spend by model and subagent | `extensions/costs.ts` | `/costs` |
| Live subagent panel | `extensions/subagent-view.ts` | appears during a fan-out; `/subagents` pins it, `/subagents open <n>` inspects one |
| Destructive-command guard | `extensions/guard.ts` | always on; `PI_DISTRO_GUARD=off` to disable |
| Reviewer gets the diff | `extensions/review-context.ts` | automatic when a reviewer is dispatched |
| Notes across sessions | `extensions/remember.ts` | `/remember <note>`, `-g` for all projects |
| Handoff to a fresh session | `extensions/handoff.ts` | `/handoff [focus]` |
| Notification after long runs | `extensions/notify.ts` | runs of 30s or more |
| Lean prompt, fixed tool set | `extensions/lean-prompt.ts`, `tool-loadout.ts` | always on |

A request carries about 2.8k tokens of prompt and tool declarations.

## Configuration

- `pi-distro.json` in the agent directory: `disabledTools` (default `["lsp_*"]`),
  `subagentConcurrency`, `gatewaySearch.model`, and `agentModels`.
- `PI_DISTRO_CACHE_WARN_TOKENS` (default 1024): reprocessed tokens that trigger a
  cache warning. `PI_DISTRO_CACHE_LOG=<file>` logs every request's cache use,
  also from subagents and print mode.
- `PI_DISTRO_NOTIFY_SECONDS` (default 30).
- Thinking level: `alt+t`, or `defaultThinkingLevel` in `settings.json`.

## Search through the gateway

`web_search` and `web_extract` are pi-deep-research's tools, backed by
`providers/gateway.ts`, so `/research` and the `researcher` subagent take the
same path and there is one place to configure credentials: `models.json`.

Search runs server-side on the gateway, under the same key as the chat models.
Because not every model runs a search tool even when its API offers one, the
configured search model is probed once and the result cached in
`<agentDir>/gateway-search.json`. A probe that fails on an auth or gateway error
is not cached, so fixing your key takes effect immediately.

Two things the gateway does differently, both handled:

- The Anthropic path separates search (`web_search_20250305`) from fetch
  (`web_fetch_20250910`), so `web_extract` gets a real page read. The Responses
  path has one tool that does both.
- When the model replies "I couldn't read that page", `extract()` reads the URL
  over plain HTTP rather than handing the research agent a description of a
  failure as if it were the page.

## Cache guard

The footer shows the prompt-cache hit rate, and a warning names the cause when a
request reprocesses more tokens than `PI_DISTRO_CACHE_WARN_TOKENS`.

Caching on a hosted gateway is automatic but not free: a cache write costs more
than a plain input token (1.25x on Anthropic's 5-minute tier, 2x on the 1-hour
one), and a read costs a tenth or less. The gateway load-balances across
deployments and the cache survives that, so the main cost is changing the prompt
head mid-session: editing the system prompt, the tool list, or the thinking
level all invalidate everything after them.

The guard understands all three payload shapes this distro uses (Chat
Completions, Responses, and Anthropic Messages, including the Responses `input`
item format) and ignores a shape it does not recognise rather than reporting a
phantom miss.

## Safety: three layers, and why they are not redundant

pi asks no approval before running a tool, so the blast radius of a bad `bash`
call is the whole machine. Every serious reported incident with a coding agent
has been a shell command or a credential, not a reasoning failure.

**1. `/plan` (read-only mode).** An allowlist of read-only commands, with a
shell-quoting-aware scanner. Use it before you trust a plan.

**2. The guard (`extensions/guard.ts`).** Always on. It reads *intent* and denies
a short list of irreversible operations — force-push, history rewrite,
`rm -rf` outside the workspace or over a glob, deletes and reads of credential
paths, writes into `.git`, `sudo`, `mkfs`, `dd of=…` — plus wrapper forms like
`xargs rm -rf /` and `sh -c "…"`. A denial is returned to the model with the
reason, so it reroutes instead of retrying.

**3. nono (`scripts/sandbox.sh`).** Kernel-enforced containment of the whole pi
process (Landlock on Linux, Seatbelt on macOS). It has no opinion about meaning;
it refuses syscalls.

Neither of the last two covers the other, measured on this machine:

| | guard | nono |
|---|---|---|
| `git push --force` | **blocked** | **allowed** — it is a local git op plus an allowed host |
| a build script that reads `~/.ssh` | **allowed** — the guard cannot see inside | **blocked** — the syscall fails |
| network to an unapproved host | no opinion | **blocked** |

```sh
./scripts/sandbox.sh                       # pi, sandboxed, cwd writable
./scripts/sandbox.sh --print-alias         # alias pi='…/sandbox.sh'
./scripts/sandbox.sh --allow-domain github.com -- -p "fix the tests"
```

The alias is the supported way to make bare `pi` sandboxed. Do not wrap the
binary on `PATH`: pi's updater rewrites `~/.pi/agent/bin/pi`, so anything
installed there is silently replaced.

`~/.ssh` is deliberately **not** granted: a read grant there makes private keys
readable to the agent, which re-opens exactly the hole the sandbox closes. Run
`git push` yourself, in the host shell.

## Known gaps

- `multi-review` is still a symlink to a personal repo in this clone, not part of
  the package; see `PLAN-gateway.md` step 7.
- pi-deep-research reads its providers and settings from
  `~/.pi/agent/pi-deep-research` even with `--dir`.
- The gateway publishes no per-model rate limits, so concurrency is a guess
  until a 429 says otherwise.
- A virtual-model router is deliberately not implemented: published results
  favour a model fixed per thread over per-turn switching, and the per-role
  subagent split already captures most of that saving.

## Edit tool

The distro keeps pi's own `edit`. In `bench/edit`, Qwen 3.8 27B passed all 18
runs with it and no tool errors, while pi-hashline-edit-pro used 35% more input
for the same result. Re-run the benchmark with your model to check.
