/**
 * Elapsed time next to "Working…" in the input bar.
 *
 * A long agent run is otherwise opaque: the spinner spins and nothing says
 * whether this has been going for eight seconds or eight minutes. This keeps the
 * working message live, ticking once a second from the moment the run starts.
 *
 * The timer ends at `agent_settled`, not `agent_end`, because pi may still
 * auto-retry, compact and retry, or continue with a queued message after
 * `agent_end` — the run a person is waiting on is the one that has settled.
 *
 * The message is restored to pi's default afterwards, so this does not become a
 * permanent change to the prompt bar.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** `8s`, `1m05s`, `1h02m` — short enough to sit in the working row. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The working message for an elapsed time. */
export const workingLabel = (ms: number): string => `Working… ${formatElapsed(ms)}`;

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;

  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  pi.on("agent_start", (_event, ctx) => {
    // Without a UI there is nothing to paint, and a timer would keep the
    // process alive for a message nobody sees.
    if (!ctx.hasUI) return;
    startedAt = Date.now();
    stop();
    ctx.ui.setWorkingMessage(workingLabel(0));
    timer = setInterval(() => ctx.ui.setWorkingMessage(workingLabel(Date.now() - startedAt)), 1000);
    (timer as { unref?: () => void }).unref?.();
  });

  pi.on("agent_settled", (_event, ctx) => {
    stop();
    // Back to pi's own message rather than a frozen "Working… 42s".
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => stop());
}
