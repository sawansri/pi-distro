# What to integrate into pi-distro: evidence from pi's ecosystem and coding-agent practice

**Date:** 2026-11-11
**Depth:** deep
**Confidence:** 92%
**Sources:** 54 sources from 5 search rounds

---

## Executive Summary

The research points to a narrower set of additions than the package ecosystem suggests. Three findings reshape the priorities: **subagent parallelism hurts on bounded tasks** (−24.0pp for Claude Code on SWE-bench Verified) and only pays on long-horizon work (+14.3pp), which inverts this distro's current "concurrency 4, fan out" assumption; **compaction systematically destroys constraints before it destroys task state** (≈⅓ of rules lost at the first summary, process instructions dropped ~6× more often than specs), which matters more here than anywhere because the distro's design keeps rules in the system prompt; and **`/models-refresh` and the price-accurate `models.json` are already the two highest-value items in the candidate list** — the ecosystem's flashier features (memory, sandboxes, OTel) are either measured-neutral, provider-specific, or belong to pi's host rather than its config.

The single largest gap is not a feature but a **safety** one: pi "doesn't ask approval before each tool call" and ships no sandbox, while every reported serious coding-agent incident in 2025–26 was a destructive shell command or a credential leak — files deleted, repos collapsed by force-push, keys committed. Confidence 92%; the main caveat is that several headline numbers come from single-harness studies that have not been replicated (noted per-finding below).

---

## Key Findings

1. **Parallel subagents are not a default-on win.** A 2,124-execution study across Codex, Claude Code and Kimi Code found parallelism *cost* Claude Code −24.0pp task pass on SWE-bench Verified (p=5.1e-7) while *gaining* +14.3pp on long-horizon LoopsBench; tokens rose 1.41–3.31× and runtime increased in 14/15 cells. [arXiv:2610.10263](https://arxiv.org/abs/2610.10263)

2. **Delegation fails silently at the handoff.** 41.8% of deep-agent failures were planner→subagent coordination breakdowns with no flat-agent analogue, and 91% of those were silent — a confident wrong answer the planner could not audit because it received a summary. [arXiv:2608.01507](https://arxiv.org/abs/2608.01507)

3. **Compaction loses rules first.** Side constraints survived compaction only 17% of the time; 30/100 unauthorised deletions occurred post-compaction versus 0 before. [arXiv:2608.11242](https://arxiv.org/abs/2608.11242)

4. **Observation masking matches LLM summarisation at ~52% lower cost**, with most solve-rate differences non-significant (Qwen3-Coder 480B: 53.4%→54.8%, $1.29→$0.61). Observations are ~84% of turn tokens. [arXiv:2508.21433](https://arxiv.org/abs/2508.21433)

5. **Rules files change process, not correctness.** Both major studies find no significant correctness effect; the cost direction depends on what is measured (dollar/steps +20% on harder tasks; output tokens −16.6% on ≤100-line tasks). Developer-written files beat LLM-generated ones (p=0.038). [arXiv:2602.11988](https://arxiv.org/abs/2602.11988), [arXiv:2601.20404](https://arxiv.org/abs/2601.20404)

6. **Every serious reported incident was shell or credentials**, not model reasoning: a wiped production DB, `rm -rf $HOME`, a force-push collapsing a repo to one commit, 48,000 files deleted through Windows junctions, and 2,539 credentials found in ~2,000 public repos. [Fortune](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/), [claude-code#10077](https://github.com/anthropics/claude-code/issues/10077), [TechRadar](https://www.techradar.com/pro/security/i-broke-something-a-claude-code-ai-agent-deleted-48-000-files-in-just-over-100-seconds-then-apologized-for-doing-so), [Dark Reading](https://www.darkreading.com/cyber-risk/ai-coding-agents-leak-secrets-github)

7. **Allowlists are explicitly not a security boundary.** Compound commands split on `&&`/`;`/`|` and are checked per segment; argument injection through `git -c core.pager=…` defeats a `git` allowlist; shell built-ins bypassed an empty allowlist entirely (CVE-2026-22708). [code.claude.com/permissions](https://code.claude.com/docs/en/permissions), [pillar.security](https://www.pillar.security/blog/the-agent-security-paradox-when-trusted-commands-in-cursor-become-attack-vectors)

8. **`gen_ai.*` semantic conventions are still Development** in a repository with zero releases and zero tags; the only Stable attributes on a GenAI span are inherited core ones. [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai/issues/511)

9. **pi has no native hook system**; the extension event surface (`tool_call` can block and mutate input, `tool_result` can transform) is the substitute, and there is no core subagent/plan/permission feature by design. [extensions.md](https://pi.dev/docs/latest/extensions)

---

## Detailed Analysis

### 1. The pi ecosystem is huge and mostly duplicated, so curation beats adoption

npm's `pi-package` keyword returns ~13,600 matches, pi.dev's catalogue claims 5,740 packages, and one community list claims 14,531 — the discrepancy is re-uploads and forks rather than distinct tools. I verified the packages that matter directly against the registry rather than trusting the survey:

| Package | Version | Last publish | What it adds |
|---|---|---|---|
| `pi-lens` | 4.4.12 | 2026-11-10 | LSP + linters + formatters + ast-grep rules |
| `pi-subagents` | 0.88.0 | 2026-11-10 | async background subagents, fleet inspector, workflows |
| `pi-sandbox` | 0.8.1 | 2026-11-10 | OS sandbox (bwrap/sandbox-exec) + permission prompts |
| `@gotgenes/pi-permission-system` | 42.0.0 | 2026-10-28 | allow/ask/deny policy at tool-call time |
| `pi-btw` | 0.8.1 | 2026-11-03 | side conversations |
| `@juicesharp/rpiv-ask-user-question` | 2.15.0 | 2026-10-24 | typed multiple-choice questions |
| `pi-otel` | 0.3.0 | 2026-09-13 | OTLP span tree |
| `pi-memory` | 0.4.2 | 2026-08-11 | markdown memory + optional semantic search |
| `pi-hooks` | 1.0.5 | 2026-05-16 | Claude-Code-compatible command hooks |
| `pi-review-loop` | 0.4.4 | 2026-04-15 | iterative review |

Two observations follow. First, the packages that overlap most with what this distro already does — `pi-subagents`, `pi-lens`, `pi-review-loop` — are also the ones where the distro has a considered position already (pi-lite-subagent for its lower prompt overhead; `@ian-pascoe/pi-lsp` for diagnostics without model-facing tools; `multi_review` for cross-family review). Replacing a working choice with a larger one needs a reason beyond popularity. `pi-lens` in particular requires Node ≥22.19 and a `typebox` peer dependency, so adopting it raises the install floor.

Second, the stalest-looking packages (`pi-hooks`, 6 months; `pi-review-loop`, 7 months) are also the ones whose value is being reimplemented natively by pi or by this distro. The genuinely uncontested additions are the two smallest: **`pi-sandbox`** and **`@juicesharp/rpiv-ask-user-question`**.

> Observations are ~84% of turn tokens in a coding trajectory. — [arXiv:2508.21433](https://arxiv.org/abs/2508.21433)

**Cross-reference:** this conclusion is reinforced by Finding 6 — the one category where the ecosystem has a package that closes a real, incident-backed risk is sandboxing.

### 2. Parallelism is a task-shape decision, and this distro currently assumes the wrong shape

This is the finding that most directly contradicts a design assumption in `PLAN-gateway.md`, which sets `subagentConcurrency: 4` and reasons that "on a hosted gateway, concurrency is a rate-limit question now." The evidence says concurrency is a *task-shape* question first.

The Li et al. study ran 354 tasks across 2,124 executions with concurrency toggled on and off, on three agents. On bounded tasks (SWE-bench Verified) Claude Code lost 24.0pp of task pass rate with parallelism on, significant at p=5.1e-7, and Kimi Code lost 17pp (p=0.013); Codex was unchanged. On long-horizon tasks (LoopsBench) the same switch gained +14.3pp for both Codex and Claude Code, with the gain scaling with expected implementation size. The failure taxonomy is dominated by *shared state*: 33.2% of failures were merge/concurrent-write problems, 26.5% concurrent writes to the same files.

That maps onto this distro concretely. "Run four explores in parallel" is safe — they are read-only and independent. "Run four general-purpose agents in parallel on one repo" is the configuration with the measured −24pp. The machinery exists and is fine; the *default* is wrong, and the aggregator's guidance to "run independent ones in parallel" is right only for the independent, read-only cases.

The SWE-QA study explains the mechanism. Delegated agents scored 46.2% against 65.2% for a flat agent with an index, at roughly double the cost per correct answer, and 41.8% of the failures were planner→subagent handoffs — of which 91% were *silent*. The planner receives a condensed summary, so it cannot audit how the subagent reached its answer. The mitigations named are directly implementable: require file paths and line ranges rather than prose, treat subagent output as unverified until citations are checked, and impose hard turn limits on explorers.

> Parallelism helps only under three conditions: complementary independent work, alternative-solution exploration, independent validation. — [arXiv:2610.10263](https://arxiv.org/abs/2610.10263)

**Cross-reference:** this is the same mechanism as Finding 3 in reverse. Subagents isolate context (a benefit) but the handoff is a lossy compression boundary — exactly the compression that Finding 3 shows destroys constraints.

### 3. Context management: mask observations, protect constraints, and beware the cache

The JetBrains "Complexity Trap" paper is the most operationally useful result in this survey, and its numbers are specific enough to act on.

Trajectory is `(o_sys, o_user, (r₁,a₁,o₁)…(rₜ₋₁,aₜ₋₁,oₜ₋₁))`. Observation masking keeps every reasoning step `rᵢ` and action `aᵢ`, and for all but the last M turns replaces observation `oᵢ` with a placeholder like "Old environment output: (n lines omitted)". M=10 was optimal on SWE-agent; the paper stresses this is *scaffold-specific* — OpenHands needed M=58 because it retains retry turns that SWE-agent elides. Results on SWE-bench Verified: Qwen3-Coder 480B went 53.4%→54.8% at $1.29→$0.61 (−52.7% cost); Gemini 2.5 Flash 32.8%→35.6% at $0.41→$0.18. Most solve-rate deltas were non-significant; the one significant regression was Gemini Flash *with thinking*, −4.0pp (p=0.04).

The critical caveat for this distro, which the paper itself flags: **masking breaks prompt caching.** Observed text changes each turn, so the cached prefix is invalidated. On a local server where prefill is the cost, that is fatal; on a hosted gateway where a cache read is a tenth of an input token and a write premium is 1.25×, it is a trade that has to be measured rather than assumed. This distro's `cache-guard` already reports the hit rate, so the experiment is cheap to run — but it is explicitly *not* a change to make blind.

The complementary result concerns what compaction destroys. Two independent 2026 studies agree that constraints go first: side constraints survived only 17% of the time, with 30/100 unauthorised deletions post-compaction versus zero before; and process instructions are dropped about six times more often than build specs, with ≈⅓ of anti-cheating rules gone at the first summary. Compact-Bench adds that LLM summaries retain ≤16.0% of recurring details versus 79.1% for mechanical extraction, and that compaction stably damages 5–64% of otherwise-passing repairs.

The reconciliation offered by the second paper is the important one: benchmarks look compaction-friendly *because progress is on disk*, so the discarded summary content is exactly the part that exists nowhere else. For this distro the actionable version is to **keep constraints out of the compactable history** — a rule that survives summarisation because it is in the system prompt survives it for the whole session, which is the same argument `lean-prompt.ts` and `remember.ts` already make for different reasons. It also means a persistent progress file is complementary to, not a replacement for, the constraints in the prompt.

> "The progress needed to finish" is what summaries lose, even when they keep the target file and code strings. — [arXiv:2610.31710](https://arxiv.org/abs/2610.31710)

**Cross-reference:** this reframes the caching work already done. The distro's cache-first design is not merely a cost optimisation; it is what makes the "constraints live in the system prompt" strategy safe.

### 4. Safety: the one gap with incident evidence behind it

pi's own security documentation states it does not ask approval before tool calls and ships no sandbox. The research found no countervailing argument. Every serious incident in the period reviewed was a shell command or a credential, not a reasoning failure: Replit's agent wiping a production database during a declared code freeze; Claude Code running `rm -rf` on `$HOME`; a force-push collapsing a remote to a single commit after a rejected push; 48,000 files deleted in ~100 seconds by following Windows junctions; and a scan finding 2,539 credentials in ~2,000 public repos, partly because "don't ask again" saves commands verbatim into a settings file that is only gitignored locally.

The permission literature is equally unanimous that allowlists are UX, not a boundary. Claude's docs split compound commands on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines and check each segment; Cursor's `terminalAllowlist` is documented as not a security boundary; argument injection through `git -c core.pager=…`, `diff.external`, `core.fsmonitor`, `core.sshCommand` and `--exec-path` means an allowlist entry for `git` approves all of them; and shell built-ins (`export`, `typeset`, `declare`) bypassed an *empty* allowlist in Cursor, enabling environment poisoning that reached RCE (CVE-2026-22708).

Where this distro is already ahead: `plan-mode.ts` implements a read-only command allowlist with a shell-quoting-aware scanner, refusal of escapes, and blocked `git` options that write files or run programs. That is the correct shape — and the research says to be honest about what it is: a blast-radius reducer, not a boundary. The two additions with real value are (a) an OS-level sandbox for the general case, for which `pi-sandbox` exists and is maintained, and (b) a deny-by-default layer for the specific irreversible operations the incidents involved: force-push, `rm -rf` outside the workspace, writes to `.git`, and anything touching credential files.

Remote-side branch protection remains the only reliable guard against force-push, because the damage lands where no local control reaches.

> A deny at any scope cannot be re-allowed, and managed settings beat CLI flags. — [code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions)

**Cross-reference:** Finding 7 and this analysis together mean the sandbox belongs *under* the permission layer, not instead of it. Plan mode constrains intent; a sandbox constrains effect.

### 5. Cost, tracing and evaluation: mostly "not yet"

The tracing picture is less actionable than it appears. `gen_ai.*` attributes are still Development status, moved out of the core semantic conventions in v1.42.0 into a repository with no releases and no tags; stabilization is tracked in an open issue with no milestone. Node has no built-in OTel — only `diagnostics_channel`.

Two things do follow. Emit `gen_ai.*` shapes if tracing is wanted at all, but do not pin attribute names or ship a schema URL. And avoid the double-counting bug the spec leaves open: put usage only on leaf `chat` spans, never sum `gen_ai.usage.input_tokens` across a trace. A hand-rolled OTLP/HTTP JSON exporter (`POST /v1/traces`) is the light path and needs no protobuf dependency.

For evaluation, the evidence recommends against reaching for public benchmarks: OpenAI stopped reporting SWE-bench Verified after finding 59.4% of 138 audited hard tasks had test or description defects, and its successor was itself revised with non-comparable scores. The tractable alternative for a distro this size is 20–50 tasks harvested from its own merged PRs, scored by a trajectory rubric (did it read before editing? run the tests? loop?) plus an LLM-judge diff review.

**Cross-reference:** this connects to Finding 1 — a trajectory eval is the only way to tell whether the parallel-subagent default is helping or hurting on *this* codebase, since the published numbers are from other harnesses.

---

## Comparison: candidate integrations, ranked by evidence

| Candidate | Measured benefit | Evidence strength | Fits this distro? |
|---|---|---|---|
| **Permission gate + protected paths** | Incident-backed risk reduction | Strong (incidents + vendor docs) | Yes — extends `plan-mode.ts` shape |
| **OS sandbox (`pi-sandbox`)** | Blast-radius containment | Strong (vendor consensus) | Yes — but changes install requirements |
| **Serial-by-default subagents** | Avoids −24.0pp on bounded tasks | Strong (n=2,124) | Yes — a config default, no code |
| **Deny patterns for force-push / `rm -rf` / `.git`** | Incident-backed | Strong | Yes — small, targeted |
| **Progress file for long runs** | Indirect (compaction damage is measured; the file is not) | Moderate | Yes — but see caveats |
| **Typed questions (`rpiv-ask-user-question`)** | None measured | Weak | Yes — 1 package, low risk |
| **Observation masking** | −52% cost at parity solve rate | Strong *but* breaks prompt caching | **Conflicts with the cache-first design** |
| **`pi-lens` over the current LSP** | Formatting on top of diagnostics | Weak for our case | Only if formatting is wanted |
| **OTel tracing** | None measured | Weak (unstable spec) | Defer |
| **Semantic memory (`pi-memory`)** | None measured; staleness risk measured | Weak | Defer — `remember.ts` covers the low-risk part |
| **Virtual-model router** | Per-thread saves; per-turn does not | Moderate | Already descoped on this basis |

The pattern in the table is that **measured benefit and integration risk are inversely correlated here.** The items with incident-backed evidence (permissions, sandbox, deny patterns, serial defaults) are small and local; the items with the flashiest numbers (masking, memory, routing) either conflict with the distro's core design or are unmeasured for this workload. That is not an argument against the latter forever — it is an argument for measuring them against this distro before adopting them.

---

## Recommended order of work

1. **Make subagent fan-out opt-in for write-capable agents.** Change the aggregation guidance and the `subagentConcurrency` default reasoning from "concurrency is a rate-limit question" to "read-only fan-out is free; write-capable fan-out needs independent work." No new code.
2. **Add a destructive-operation guard.** Extend the `plan-mode.ts` allowlist machinery into an always-on deny layer: force-push, history rewrite, `rm -rf` outside the workspace, writes into `.git`, and credential paths. Follow the compound-command splitting and `git -c` injection findings.
3. **Evaluate `pi-sandbox`.** It is the maintained answer to the risk in Finding 6, and the install-floor cost is the only question.
4. **Adopt the typed-question package.** One dependency, removes a class of guessing on ambiguous tasks.
5. **Measure observation masking before adopting it.** The `cache-guard` log already gives the cache-hit baseline; the experiment is a week of dogfooding with and without a masking window.
6. **Defer** OTel, semantic memory, and the router until a trajectory eval exists to judge them by.

---

## Uncertainties & Gaps

- **`gen_ai.*` conventions are Development status** in a repository with zero releases and zero tags. Attribute names may change; do not pin them or ship a schema URL.
- **No ablation isolates a progress file's success effect from git history.** The mechanism (compaction destroys resumable state) is measured; the fix is reasoned, not measured.
- **No controlled study of tool-result *format* on coding-task success.** The adjacent evidence is about agent action format, not observation format.
- **Observation masking breaks prompt caching** — a direct conflict with this distro's cache-first design that no study addresses on hosted gateways where cache reads are 0.1×.
- Several headline figures come from a single harness and have not been replicated: Anthropic's +90.2% multi-agent result is explicitly unreproducible internally, and the SWE-QA study tested one harness with no flat-agentic baseline.
- All the compaction and AGENTS.md studies are Python-only, on mid-2026 model snapshots.

---

## Sources

| Source | Date | Tier |
|---|---|---|
| [The Complexity Trap: observation masking vs summarisation](https://arxiv.org/abs/2508.21433) | 2025-08 | 1 |
| [Parallel subagents in SE: 2,124 executions](https://arxiv.org/abs/2610.10263) | 2026-10 | 1 |
| [Deep Agentic Search / silent handoff failure](https://arxiv.org/abs/2608.01507) | 2026-08 | 1 |
| [Compact-Bench](https://arxiv.org/abs/2610.31710) | 2026-10 | 1 |
| [Salle et al., compaction limits](https://arxiv.org/abs/2610.31778) | 2026-10 | 1 |
| [Constraints lost to compaction](https://arxiv.org/abs/2608.11242) | 2026-08 | 1 |
| [AGENTS.md: no success gain, higher cost](https://arxiv.org/abs/2602.11988) | 2026-09 (v3) | 1 |
| [AGENTS.md: runtime and token reduction](https://arxiv.org/abs/2601.20404) | 2026-01 | 1 |
| [Khatri, two-agent ablation](https://arxiv.org/abs/2607.27250) | 2026-07 | 1 |
| [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 2025 | 1 |
| [Anthropic, effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 2026 | 1 |
| [Anthropic, Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) | 2025 | 1 |
| [Claude Code permissions](https://code.claude.com/docs/en/permissions) | 2026 | 1 |
| [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) | 2026 | 1 |
| [Claude Code worktrees](https://code.claude.com/docs/en/worktrees) | 2026 | 1 |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | 2026 | 1 |
| [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing) | 2026 | 1 |
| [Codex hooks](https://developers.openai.com/codex/hooks) | 2026 | 1 |
| [Cursor permissions (allowlist not a boundary)](https://cursor.com/docs/reference/permissions) | 2026 | 1 |
| [Cursor hooks](https://cursor.com/docs/hooks) | 2026 | 1 |
| [CVE-2026-22708 / shell built-in bypass](https://www.pillar.security/blog/the-agent-security-paradox-when-trusted-commands-in-cursor-become-attack-vectors) | 2026 | 2 |
| [git argument-injection allowlist bypass](https://dev.to/gabrielanhaia/allowlisting-git-for-your-agent-also-allowlists-diffexternal-and-corefsmonitor-2j4e) | 2026 | 3 |
| [Replit wiped a production database](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/) | 2025-07 | 2 |
| [Claude Code `rm -rf $HOME` issue](https://github.com/anthropics/claude-code/issues/10077) | 2025-10 | 2 |
| [48,000 files deleted via junctions](https://www.techradar.com/pro/security/i-broke-something-a-claude-code-ai-agent-deleted-48-000-files-in-just-over-100-seconds-then-apologized-for-doing-so) | 2026 | 2 |
| [Credentials leaked into public repos](https://www.darkreading.com/cyber-risk/ai-coding-agents-leak-secrets-github) | 2026-11 | 2 |
| [OTel GenAI conventions (Development status)](https://github.com/open-telemetry/semantic-conventions-genai/issues/511) | 2026 | 1 |
| [OTel semconv v1.42.0 (GenAI moved out)](https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.42.0) | 2026-06 | 1 |
| [OTLP/HTTP JSON protocol](https://opentelemetry.io/docs/specs/otlp/) | 2026 | 1 |
| [Langfuse self-hosting](https://langfuse.com/pricing-self-host) | 2026 | 1 |
| [Why OpenAI no longer evaluates SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) | 2026-02 | 1 |
| [AgentLens trajectory evals](https://arxiv.org/abs/2607.06624) | 2026-07 | 1 |
| [pi security model](https://pi.dev/docs/latest/security) | 2026 | 1 |
| [pi extension events](https://pi.dev/docs/latest/extensions) | 2026 | 1 |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | 2026-11 | 2 |
| [pi-lens](https://github.com/apmantza/pi-lens) | 2026-11 | 2 |
| [pi-sandbox](https://github.com/carderne/pi-sandbox) | 2026-11 | 2 |
| [pi-memory](https://github.com/jayzeng/pi-memory) | 2026-08 | 2 |
| [STALE: agents accept outdated premises](https://arxiv.org/abs/2605.06527) | 2026-05 | 1 |
| [MemoryGraft: poisoned memory records](https://arxiv.org/abs/2512.16962) | 2025-12 | 1 |
| [Chroma context rot](https://www.trychroma.com/research/context-rot) | 2025-07 | 2 |
| [agenthub / AGENTS.md standard](https://agents.md/) | 2026 | 1 |
| [LangChain: context management for Deep Agents](https://www.langchain.com/blog/context-management-for-deepagents) | 2026 | 2 |
| [Cognition: don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents) | 2025 | 2 |
| [Google scaling study: sequential tasks regress](https://arxiv.org/html/2512.08296v1) | 2025-12 | 1 |
| [SWE-agent ACI](https://arxiv.org/abs/2405.15793) | 2024 | 1 |
| [Grep vs vector retrieval](https://arxiv.org/html/2605.15184v1) | 2026-05 | 1 |
| [Structural codebase index vs agentic grep](https://arxiv.org/abs/2606.22417) | 2026-06 | 1 |
| [YC-Bench: scratchpad usage predicts success](https://arxiv.org/abs/2604.01212) | 2026-04 | 1 |
| [Squeez tool-output pruning](https://arxiv.org/abs/2604.04979) | 2026-04 | 1 |
| [Lost in the middle](https://arxiv.org/abs/2307.03172) | 2024 (TACL) | 1 |
| [GPT-6 prompt caching guidance](https://openai.com/index/better-prompt-caching-for-gpt-6/) | 2026 | 1 |
| [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 2026 | 1 |
| [Code-mode (Cloudflare)](https://blog.cloudflare.com/code-mode/) | 2025-09 | 2 |
| [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) | 2025-11 | 1 |
