/**
 * Subagent concurrency for pi-lite-subagent.
 *
 * Sets PI_SUBAGENT_MAX_CONCURRENCY from `subagentConcurrency` in pi-distro.json
 * unless the environment already sets it. On a hosted gateway the ceiling is
 * throughput rather than prefill, so the cap is generous; what limits fan-out is
 * the work, not the slot count. Parallel write-capable agents measured *worse*
 * than serial (concurrent edits to one tree clobber each other), while read-only
 * exploration parallelises freely — see the subagent line in lean-prompt.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";

export default function (_pi: ExtensionAPI) {
  const concurrency = readConfig().subagentConcurrency;
  if (process.env.PI_SUBAGENT_MAX_CONCURRENCY === undefined && Number.isInteger(concurrency) && concurrency! >= 1) {
    process.env.PI_SUBAGENT_MAX_CONCURRENCY = String(concurrency);
  }
}
