/**
 * /models-refresh: rebuild the gateway's entries in `models.json` on demand.
 *
 * The installer does this once, at install time. Prices move, models are added
 * and retired, and a gateway that was unreachable during install leaves the
 * template's fallback list behind. This command re-reads the catalogue from the
 * endpoint already in `models.json`, so nothing about the gateway is hardcoded
 * here: it uses whatever providers you configured and however you configured
 * their credentials.
 *
 * Three rules, because models.json is the user's file as much as ours:
 *
 * - Only providers on a real HTTP endpoint are touched, and only if they look
 *   like this distro's gateway (`gateway` / `gateway-*`). A personal provider
 *   next to them is never rewritten.
 * - Models the catalogue lists replace the generated ones, including their
 *   prices. A model the catalogue does not list is kept, because it cannot tell
 *   a retired model from one you added by hand; `--prune` drops them instead.
 * - Nothing is written when nothing changed, and nothing is written at all on a
 *   failed fetch: a gateway outage must not empty your model list.
 *
 * pi reads models.json at startup and `/reload` does not cover it, so the
 * command says plainly that a restart is needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { catalogModel, fetchCatalog, isPlaceholder, mergeModels, servedApi } from "./catalog.ts";

const GATEWAY_PROVIDER = /^gateway(-|$)/;

/** Providers this command may rewrite: the distro's gateway, on a real endpoint. */
function managedProviders(providers: Record<string, any>) {
  return Object.entries(providers).filter(
    ([name, provider]) =>
      GATEWAY_PROVIDER.test(name) && /^https?:\/\//.test(String(provider?.baseUrl ?? "")) && !isPlaceholder(provider.baseUrl),
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("models-refresh", {
    description: "Rebuild the gateway model list in models.json from the gateway's catalogue (--prune drops retired ones)",
    handler: async (args, ctx) => {
      // A model the gateway has retired stays in the list unless asked: the
      // catalogue cannot tell a retired ID from one the user added by hand.
      const prune = /(^|\s)--prune(\s|$)/.test(args ?? "");
      const say = (message: string, level: "info" | "warning" | "error") => {
        ctx.ui.notify(message, level);
        // notify is a no-op without a UI (print mode), and so is a silent
        // refresh failure, which is the one thing worth seeing in a script.
        if (!ctx.hasUI || level === "error") console.error(message);
      };
      const file = path.join(getAgentDir(), "models.json");
      let modelsJson: any;
      try {
        modelsJson = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        say(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const providers = modelsJson.providers ?? {};
      const managed = managedProviders(providers);
      if (managed.length === 0) {
        say("No gateway provider in models.json; run install.sh with --gateway first.", "warning");
        return;
      }

      // Try each managed provider until one answers. They normally share an
      // endpoint, so this only matters when one was hand-edited or a gateway
      // moved, but picking the first blindly turned a dead URL into
      // "already up to date".
      let entries: any[] | undefined;
      const failures: string[] = [];
      for (const [name, provider] of managed) {
        const result = await fetchCatalog(provider.baseUrl, provider);
        if (result.entries) {
          entries = result.entries;
          break;
        }
        failures.push(`${name}: ${result.error}`);
      }
      if (!entries) {
        // Leaving the file untouched is the point: a failed refresh must not
        // look like an empty catalogue and wipe the list.
        say(`Could not read the model catalogue (${failures.join("; ")}). models.json is unchanged.`, "error");
        return;
      }

      // Split the catalogue by the API each model is served on, so every model
      // lands under a provider that will actually accept it.
      const byProvider: Record<string, any[]> = {};
      for (const entry of entries) {
        const api = servedApi(entry);
        if (!api) continue;
        const model = catalogModel(entry);
        if (api !== "anthropic-messages") model.api = api;
        const name = api === "anthropic-messages" ? "gateway-anthropic" : "gateway";
        (byProvider[name] ??= []).push(model);
      }

      const before = JSON.stringify(modelsJson);
      let updated = 0;
      let keptTotal = 0;
      for (const [name, provider] of managed) {
        const catalogModels = byProvider[name];
        if (!catalogModels || catalogModels.length === 0) continue;
        const existing: any[] = provider.models ?? [];
        provider.models = mergeModels(existing, catalogModels, prune);
        const kept = provider.models.filter((model: any) => !catalogModels.some((fresh) => fresh.id === model.id));
        keptTotal += kept.length;
        updated += 1;
      }

      if (JSON.stringify(modelsJson) === before) {
        say("models.json is already up to date.", "info");
        return;
      }
      try {
        fs.writeFileSync(file, `${JSON.stringify(modelsJson, null, 2)}\n`);
      } catch (error) {
        say(`Cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const total = Object.values(byProvider).reduce((sum, list) => sum + list.length, 0);
      const keptNote = keptTotal > 0 ? `, kept ${keptTotal} the catalogue does not list` : "";
      const hint = prune ? "" : "; pass --prune to drop models the gateway no longer lists";
      say(
        `Refreshed ${updated} provider(s), ${total} models from the gateway${keptNote}${hint}. Restart pi to use them (/reload does not reload models.json).`,
        "info",
      );
    },
  });
}
