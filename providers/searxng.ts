/**
 * pi-deep-research search provider: SearXNG (local metasearch).
 * From pi-deep-research's examples/providers/searxng.ts (MIT), ported from PR #4 by @fank.
 *
 * The instance URL comes from SEARXNG_BASE_URL, or else from "baseUrl" in
 * ~/.pi/agent/pi-deep-research/searxng.json, which pi-distro's installer
 * writes (`--searxng <url>`), so it works without the variable in every shell.
 *
 * SearXNG's JSON API is off by default (403). Enable it in settings.yml:
 *   search:
 *     formats:
 *       - html
 *       - json
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function baseUrl(): string | undefined {
	if (process.env.SEARXNG_BASE_URL) return process.env.SEARXNG_BASE_URL;
	try {
		const config = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-deep-research", "searxng.json"), "utf-8"));
		return typeof config?.baseUrl === "string" && config.baseUrl ? config.baseUrl : undefined;
	} catch {
		return undefined;
	}
}

export default {
	name: "searxng",
	tier: "local" as const,
	isConfigured: () => Boolean(baseUrl()),
	async search(req: { query: string; maxResults: number; signal?: AbortSignal }) {
		const base = baseUrl()!.replace(/\/+$/, "");
		const params = new URLSearchParams({
			q: req.query,
			format: "json",
			language: "en",
			categories: "general",
		});
		const resp = await fetch(`${base}/search?${params}`, {
			signal: req.signal ?? AbortSignal.timeout(30000),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`SearXNG search error ${resp.status}: ${text}`);
		}

		const data = (await resp.json()) as {
			results: Array<{ title: string; url: string; content: string; publishedDate?: string }>;
		};

		return (data.results ?? []).slice(0, req.maxResults).map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.content ?? "",
			publishedDate: r.publishedDate,
		}));
	},
};
