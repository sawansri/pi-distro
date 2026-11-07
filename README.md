# pi-distro

A [pi](https://pi.dev) distro for local models, tuned for Qwen 3.8 on [gufo](https://github.com/gufo-org/gufo) on AMD Strix Halo.

It aims for full features with a small prompt, and above all a prompt cache that survives the whole session.

## Design rule: the prompt head never changes

Qwen's chat template renders the system prompt, every tool definition, and the reasoning effort into the first system turn, and gufo reuses its prompt cache only on an exact token prefix. Changing any of the three mid-session reprocesses the whole conversation: tens of seconds on a long session. So in this distro:

- The system prompt, tool list, and thinking level are fixed when a session starts.
- Everything that changes during a session (plan mode, todos, diagnostics, notes) arrives as an appended message or a tool result.
- Subagents share one byte-identical prompt prefix, so gufo prefills it once for all of them.
