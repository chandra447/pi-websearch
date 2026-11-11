/**
 * Keenable — keyed when `KEENABLE_API_KEY` is set, documented public tier otherwise.
 *
 * Verified working keyless (200, ~0.4s, clean JSON with `title`/`url`/
 * `snippet`/`published_at`). Unlike the scrapers this is a purpose-built
 * search API with a real free tier, so it does not depend on the caller's IP
 * reputation the way an HTML frontend does.
 *
 * The public endpoint is rate limited per IP. When it pushes back we surface a
 * 429 and let the chain advance rather than retrying — a retry loop against a
 * per-IP limit just deepens the block.
 */

import { formatQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { clampNumResults, clipSnippet, readJson, siteHosts, toIsoDate, toSearchSources, withHardTimeout } from "./utils.ts";

const PUBLIC_URL = "https://api.keenable.ai/v1/search/public";
const KEYED_URL = "https://api.keenable.ai/v1/search";
/** Identifies the client to the public tier, as its operators ask. */
const CLIENT_TITLE = "pi-websearch";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

const KEENABLE_QUERY_SYNTAX = { phrases: true, negation: true, or: true } as const;

/** Keenable wants a closed set of relative windows, not an arbitrary date. */
const RECENCY_TO_WINDOW: Record<string, string> = {
	day: "1d",
	week: "7d",
	month: "1mo",
	year: "1y",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseKeenable(payload: unknown, limit: number): SearchSource[] {
	if (!isRecord(payload)) return [];
	const rows = Array.isArray(payload.results)
		? payload.results
		: Array.isArray(payload.data)
			? payload.data
			: Array.isArray(payload.hits)
				? payload.hits
				: [];

	const sources: Partial<SearchSource>[] = rows.filter(isRecord).map((row) => ({
		title:
			typeof row.title === "string"
				? row.title
				: typeof row.name === "string"
					? row.name
					: undefined,
		url: typeof row.url === "string" ? row.url : typeof row.link === "string" ? row.link : undefined,
		snippet: clipSnippet(
			typeof row.snippet === "string"
				? row.snippet
				: typeof row.description === "string"
					? row.description
					: typeof row.summary === "string"
						? row.summary
						: undefined,
		),
		publishedDate: toIsoDate(
			typeof row.published_at === "string"
				? row.published_at
				: typeof row.publishedDate === "string"
					? row.publishedDate
					: typeof row.acquired_at === "string"
						? row.acquired_at
						: undefined,
		),
	}));

	return toSearchSources(sources, limit);
}

export const keenableProvider: SearchProvider = {
	id: "keenable",
	label: "Keenable",
	isAvailable: () => true,

	async search(params: SearchParams): Promise<SearchResponse> {
		const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
		const parsed = params.parsedQuery;
		const key = params.credentials.keenable;
		const signal = withHardTimeout(params.signal, params.timeoutMs);

		const query = parsed.hasDirectives ? formatQuery(parsed, KEENABLE_QUERY_SYNTAX) : params.query;
		const hosts = siteHosts(parsed.sites);
		const body: Record<string, unknown> = { query, max_results: limit };
		// Keenable takes exactly one host; several stay inline via the post-filter.
		if (hosts.length === 1) body.site = hosts[0];
		if (parsed.after) body.published_after = parsed.after;
		else if (params.recency) body.published_after = RECENCY_TO_WINDOW[params.recency];

		const response = await params.fetchImpl(key ? KEYED_URL : PUBLIC_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Keenable-Title": CLIENT_TITLE,
				...(key ? { "X-API-Key": key } : {}),
			},
			body: JSON.stringify(body),
			signal,
		});

		const payload = await readJson("keenable", response);
		const sources = parseKeenable(payload, limit);
		if (sources.length === 0) {
			throw new SearchProviderError("keenable", "Keenable returned no results.", 204);
		}
		return { provider: "keenable", sources, authMode: key ? "api_key" : "keyless" };
	},
};

/** Registry-compatible alias; the registry index imports the PascalCase name. */
export const KeenableProvider = keenableProvider;
