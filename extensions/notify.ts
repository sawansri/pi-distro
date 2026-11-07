/**
 * Terminal notification when a long run finishes.
 *
 * Local models can take minutes per task, so after a run that took at least
 * PI_DISTRO_NOTIFY_SECONDS (default 30) this rings the bell and sends OSC 777
 * and OSC 9 notifications, which most terminals turn into a desktop
 * notification or a tab badge. Uses agent_settled, so it fires once pi won't
 * continue on its own (retries, compaction, queued messages).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_SECONDS = Number(process.env.PI_DISTRO_NOTIFY_SECONDS) || 30;

export default function (pi: ExtensionAPI) {
  let started: number | undefined;

  pi.on("agent_start", () => {
    started ??= Date.now();
  });

  pi.on("agent_settled", (event, ctx) => {
    const seconds = started === undefined ? 0 : (Date.now() - started) / 1000;
    started = undefined;
    if (!ctx.hasUI || !process.stdout.isTTY || seconds < MIN_SECONDS) return;
    const text = event.aborted ? "Stopped" : `Done in ${Math.round(seconds)}s`;
    process.stdout.write(`\x1b]777;notify;pi;${text}\x07\x1b]9;pi: ${text}\x07\x07`);
  });
}
