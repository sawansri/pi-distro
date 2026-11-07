/**
 * Fixed tool loadout.
 *
 * Every declared tool costs context on every request, and changing the set
 * mid-session makes the server reprocess the whole conversation. So the set is
 * chosen once, when the session starts and before the first request, and never
 * changed afterwards.
 *
 * `disabledTools` in `<agentDir>/pi-distro.json` lists tools to turn off; a
 * trailing `*` matches a prefix. The default turns off pi-lsp's model-facing
 * tools: its diagnostics still reach the model in edit and write results.
 * pi's `defaultTools: ["-name"]` setting can't do this, as it only removes
 * built-in tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";

const DEFAULT_DISABLED = ["lsp_*"];

function disabledPatterns(): string[] {
  const configured = readConfig().disabledTools;
  return Array.isArray(configured) ? configured.map(String) : DEFAULT_DISABLED;
}

const matches = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const patterns = disabledPatterns();
    const active = pi.getActiveTools();
    const kept = active.filter((name) => !patterns.some((pattern) => matches(name, pattern)));
    if (kept.length !== active.length) pi.setActiveTools(kept);
  });
}
