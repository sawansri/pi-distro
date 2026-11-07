/**
 * Reads the distro's settings from `<agentDir>/pi-distro.json`.
 * Not an extension itself; the extensions import it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface DistroConfig {
  /** Tools turned off at session start; a trailing `*` matches a prefix. */
  disabledTools?: string[];
  /** How many tasks of one parallel subagent call run at once; match the server's session count. */
  subagentConcurrency?: number;
}

export function readConfig(): DistroConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(getAgentDir(), "pi-distro.json"), "utf-8")) ?? {};
  } catch {
    return {};
  }
}
