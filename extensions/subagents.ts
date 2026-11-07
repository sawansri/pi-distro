/**
 * Subagent concurrency for pi-lite-subagent.
 *
 * gufo runs several sessions at once and prefills a prefix shared by
 * concurrent requests only once, so parallel subagents pay off. Sets
 * PI_SUBAGENT_MAX_CONCURRENCY from `subagentConcurrency` in pi-distro.json
 * (match gufo's --sessions) unless the environment already sets it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";

export default function (_pi: ExtensionAPI) {
  const concurrency = readConfig().subagentConcurrency;
  if (process.env.PI_SUBAGENT_MAX_CONCURRENCY === undefined && Number.isInteger(concurrency) && concurrency! >= 1) {
    process.env.PI_SUBAGENT_MAX_CONCURRENCY = String(concurrency);
  }
}
