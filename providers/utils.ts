/**
 * Shared provider plumbing: timeouts, result caps, error classification,
 * bot-challenge detection, source normalization.
 *
 * The timeout split matters. A per-provider ceiling is a *failure* (the chain
 * advances). A tool-call abort is a *cancellation* (the whole search stops).
 * Both arrive as `AbortError` from `fetch`, so the composed signal is built
 * with `AbortSignal.any()` and the orchestrator checks the caller's signal
 * separately before recording anything.
 */

import { SearchProviderError, type SearchSource } from "../types.ts";

/**
 * Compose the tool-call signal with a hard per-provider ceiling.
 *
 * `AbortSignal.any` keeps both: whichever fires first wins, and the caller's
 * signal stays distinguishable because the orchestrator tests it directly.
 */
export function withHardTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const ceiling = AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)));
	if (!signal) return ceiling;
	if (signal.aborted) return signal;
	return AbortSignal.any([signal, ceiling]);
}

/** Collapse `limit`/`numSearchResults` into one bounded count. */
export function clampNumResults(requested: number | undefined, fallback: number, max: number): number {
	const value = typeof requested === "number" && Number.isFinite(requested) ? Math.trunc(requested) : fallback;
	if (value <= 0) return fallback;
	return Math.min(value, max);
}

/**
 * Body markers for an anti-automation wall. Every keyless engine that gets
 * aggressive eventually answers with one of these *at HTTP 200*, so a status
 * check alone is not enough — that is exactly how a scraper silently starts
 * returning zero results forever.
 */
const CHALLENGE_MARKERS = [
	"anomaly-modal",
	"anomaly.js",
	"anubis_challenge",
	"altcha",
	"unusual traffic",
	"captcha",
	"are you a robot",
	"enable javascript and cookies to continue",
	// Egress blocks are not anti-bot puzzles but they are the same class of
	// answer: "this caller is not welcome", and retrying or checking the key is
	// pointless. Firecrawl answers keyless search this way from VPN/datacenter IPs.
	"looks like a vpn",
	"vpn or proxy",
	"anonymizing proxy",
	"datacenter ip",
];

export function isChallengeBody(body: string): boolean {
	const lower = body.toLowerCase();
	return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Turn an HTTP status into a provider error with an actionable message.
 * `undefined` means "not a classified failure" and the caller supplies its own.
 */
export function classifyProviderHttpError(provider: string, status: number, body: string): SearchProviderError | undefined {
	// Body first. A wall arrives with whatever status the engine felt like — 200,
	// 202, 403 — so testing the status first made an IP/VPN block report as
	// "authorization failed. Check the API key", which is exactly backwards and
	// sends the user to fix a credential that is fine.
	if (isChallengeBody(body)) {
		return new SearchProviderError(
			provider,
			`${provider} refused the request from this network (anti-bot wall or egress/IP block). An API key, another provider, or another network will work; retrying will not.`,
			429,
		);
	}
	if (status === 401) {
		return new SearchProviderError(
			provider,
			`${provider} rejected the API key (401). Check that the configured key is valid and not expired.`,
			status,
		);
	}
	if (status === 403) {
		return new SearchProviderError(
			provider,
			`${provider} denied the request (403). Either the API key lacks access or this network is blocked.`,
			status,
		);
	}
	if (status === 429) {
		return new SearchProviderError(provider, `${provider} rate limited (429).`, status);
	}
	if (status >= 500) {
		return new SearchProviderError(provider, `${provider} upstream error (${status}).`, status);
	}
	return undefined;
}

/** `Response` → parsed JSON, classifying transport and HTTP failures. */
export async function readJson(
	provider: string,
	response: Response,
): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		throw classifyProviderHttpError(provider, response.status, text) ??
			new SearchProviderError(provider, `${provider} returned HTTP ${response.status}.`, response.status);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new SearchProviderError(provider, `${provider} returned a non-JSON response.`, response.status);
	}
}

/** Resolve an ISO date or epoch value to an age in seconds. */
export function dateToAgeSeconds(value?: string | number): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed =
		typeof value === "number"
			? value < 1e12
				? value * 1000 // seconds
				: value
			: Date.parse(String(value));
	if (!Number.isFinite(parsed)) return undefined;
	const age = (Date.now() - parsed) / 1000;
	return age >= 0 ? Math.round(age) : undefined;
}

/** Normalize an arbitrary upstream date into ISO `YYYY-MM-DD` when possible. */
export function toIsoDate(value?: string | number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
	if (!Number.isFinite(parsed)) return undefined;
	return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Truncate a snippet at parse time, not at render time. A single Parallel
 * result can carry 10 KB of excerpt; ten of those blow Pi's 50 KB tool-output
 * budget before formatting ever runs.
 */
export function clipSnippet(value: string | undefined, max = 600): string | undefined {
	if (typeof value !== "string") return undefined;
	const flattened = value.replace(/\s+/g, " ").trim();
	if (!flattened) return undefined;
	return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

/** Keep only well-formed, absolute, de-duplicated sources, capped at `limit`. */
export function toSearchSources(raw: readonly Partial<SearchSource>[], limit: number): SearchSource[] {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		if (!/^https?:\/\/\S+/i.test(url)) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url;
		sources.push({
			title,
			url,
			...(entry.snippet ? { snippet: entry.snippet } : {}),
			...(entry.publishedDate ? { publishedDate: entry.publishedDate } : {}),
			...(typeof entry.ageSeconds === "number" ? { ageSeconds: entry.ageSeconds } : {}),
		});
		if (sources.length >= limit) break;
	}
	return sources;
}

/** Reduce `site:` values to hostnames for APIs that want bare domains. */
export function siteHosts(sites: readonly string[]): string[] {
	return sites
		.map((site) => site.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, ""))
		.filter(Boolean);
}

/** `AbortSignal`-aware `fetch` that also honours the injected test implementation. */
export type FetchImpl = typeof fetch;
