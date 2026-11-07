# pi-distro

A [pi](https://pi.dev) distro for local models, tuned for Qwen 3.8 on [gufo](https://github.com/gufo-org/gufo) on AMD Strix Halo.

It aims for full features with a small prompt, and above all a prompt cache that survives the whole session.

## Design rule: the prompt head never changes

Qwen's chat template renders the system prompt, every tool definition, and the reasoning effort into the first system turn, and gufo reuses its prompt cache only on an exact token prefix. Changing any of the three mid-session reprocesses the whole conversation: tens of seconds on a long session. So in this distro:

- The system prompt, tool list, and thinking level are fixed when a session starts.
- Everything that changes during a session (plan mode, todos, diagnostics, notes) arrives as an appended message or a tool result.
- Subagents share one byte-identical prompt prefix, so gufo prefills it once for all of them.

## Install

```sh
git clone <this repo> pi-distro && cd pi-distro
./install.sh --searxng http://localhost:8888 --sessions 4   # Linux, macOS
pi
```

- `--gufo <url>`: gufo's OpenAI-compatible URL (default `http://127.0.0.1:8080/v1`). The installer adds a `gufo` provider to `models.json` with the models the server reports, or the usual Qwen 3.8 models when it isn't running.
- `--searxng <url>`: your SearXNG instance, tried first for web search. Its JSON API must be enabled (`search.formats: [html, json]` in `settings.yml`). Without it, search goes through Exa's free endpoint, with no key.
- `--sessions <n>`: gufo's `--sessions`, the number of subagents that run at once.
- `--dir <path>`: install into a separate agent directory and start pi with `PI_CODING_AGENT_DIR=<path> pi`. pi-deep-research still reads its search settings from `~/.pi/agent/pi-deep-research`.
- `--dev`: load the extensions from this clone, so edits apply in the next session.

The installer installs pi if needed, then the pinned packages in `config/packages.txt`. It creates config files only where none exist and merges into the ones you have. Language servers found on `PATH` (typescript-language-server, basedpyright or pyright, rust-analyzer, gopls, clangd) are configured for diagnostics after edits.

## What you get

| Feature | Provided by | Use |
|---|---|---|
| Deep research with sources | [pi-deep-research](https://github.com/czhiming-maker/pi-deep-research), with `providers/searxng.ts` and `providers/exa-mcp.ts` | `/research [quick\|standard\|deep] <topic>`, or ask |
| Web search and page reading | pi-deep-research's `web_search` and `web_extract` | SearXNG, else Exa (no key), else Tavily or Brave with a key |
| Plan mode, no extra tools | `extensions/plan-mode.ts` | `shift+tab`, `/plan` |
| Subagents | [pi-lite-subagent](https://www.npmjs.com/package/pi-lite-subagent), `agents/` | explore, plan, reviewer, researcher, general-purpose |
| Todo list | [pi-todo-lite](https://www.npmjs.com/package/pi-todo-lite) | `ctrl+alt+t`, `/todos` |
| Diagnostics after edits | [@ian-pascoe/pi-lsp](https://www.npmjs.com/package/@ian-pascoe/pi-lsp) | automatic; its tools are off |
| Undo file changes | [pi-workspace-history](https://www.npmjs.com/package/pi-workspace-history) | `/undo`, `/redo`, `/diff` |
| AGENTS.md in subdirectories | [pi-subdir-context](https://www.npmjs.com/package/pi-subdir-context) | automatic, on read |
| Compaction from the prompt cache | [pi-cached-compaction](https://www.npmjs.com/package/pi-cached-compaction) | automatic, `/compact` |
| Cache hit rate and miss warnings | `extensions/cache-guard.ts` | footer; warns with the cause |
| Notes across sessions | `extensions/remember.ts` | `/remember <note>`, `-g` for all projects |
| Handoff to a fresh session | `extensions/handoff.ts` | `/handoff [focus]` |
| Notification after long runs | `extensions/notify.ts` | runs of 30s or more |
| Lean prompt, fixed tool set | `extensions/lean-prompt.ts`, `tool-loadout.ts` | always on |

A request carries about 2.8k tokens of prompt and tool declarations.

## Configuration

- `pi-distro.json` in the agent directory: `disabledTools` (default `["lsp_*"]`) and `subagentConcurrency`.
- `PI_DISTRO_CACHE_WARN_TOKENS` (default 1024): reprocessed tokens that trigger a cache warning. `PI_DISTRO_CACHE_LOG=<file>` logs every request's cache use, also from subagents and print mode.
- `PI_DISTRO_NOTIFY_SECONDS` (default 30).
- Thinking level: `alt+t`, or `defaultThinkingLevel` in `settings.json`. gufo renders it at the start of the prompt, so change it before a session rather than during one.

## Known gaps

- gufo shares a prompt prefix between concurrent requests only while one of them is prefilling it. When two subagents start together and the first restores the shared prefix from gufo's RAM cache, the second prefills it again.
- pi-deep-research reads its providers and settings from `~/.pi/agent/pi-deep-research` even with `--dir`.
