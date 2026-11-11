/**
 * SearXNG — self-hosted meta-search.
 *
 * The only keyless option that does not depend on someone else's rate limiter,
 * which makes it the sane setup for heavy use. Available only when an endpoint
 * is configured (`SEARXNG_ENDPOINT`), because a public instance chosen for you
 * would be both slow and rude.
 */

import { formatQuery, type QuerySyntax } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import {
	clampNumResults,
	clipSnippet,
	dateToAgeSeconds,
	isChallengeBody,
	readJson,
	toIsoDate,
	withHardTimeout,
} from "./utils.ts";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const SNIPPET_CHARS = 400;

/** SearXNG forwards the classic operator set to its upstream engines. */
const QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	dateRange: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
};

/** SearXNG has no `week` window; the closest supported value is a month. */
const RECENCY_TO_WINDOW: Record<"day" | "week" | "month" | "year", string> = {
	day: "day",
	week: "month",
	month: "month",
	year: "year",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Strip external `!bang` prefixes: they would redirect the query off-instance. */
function stripBangs(query: string): string {
	return query
		.split(/\s+/)
		.filter((token) => !/^![a-zA-Z]{2,}$/.test(token))
		.join(" ")
		.trim();
}

function parseSearxng(payload: unknown, limit: number) {
	const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
	const sources: SearchSource[] = [];
	for (const value of results) {
		if (!isRecord(value)) continue;
		const url = typeof value.url === "string" ? value.url.trim() : "";
		if (!url) continue;
		const snippet = clipSnippet(typeof value.content === "string" ? value.content : undefined, SNIPPET_CHARS);
		const published = toIsoDate(typeof value.publishedDate === "string" ? value.publishedDate : undefined);
		sources.push({
			title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : url,
			url,
			...(snippet ? { snippet } : {}),
			...(published ? { publishedDate: published, ageSeconds: dateToAgeSeconds(published) } : {}),
		});
		if (sources.length >= limit) break;
	}

	const answers = isRecord(payload) && Array.isArray(payload.answers) ? payload.answers : [];
	const answer = answers
		.map((entry) => (isRecord(entry) && typeof entry.answer === "string" ? entry.answer.trim() : ""))
		.find(Boolean);

	const suggestions =
		isRecord(payload) && Array.isArray(payload.suggestions)
			? payload.suggestions
					.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
					.slice(0, 8)
			: [];

	// An empty page with failing upstream engines means the instance is
	// degraded, not that the query had no matches — name the engines.
	const unresponsive =
		isRecord(payload) && Array.isArray(payload.unresponsive_engines)
			? payload.unresponsive_engines
					.map((entry) => (Array.isArray(entry) ? String(entry[0]) : String(entry)))
					.filter(Boolean)
			: [];

	return { sources, answer, suggestions, unresponsive };
}

export async function searchSearxng(params: SearchParams): Promise<SearchResponse> {
	const endpoint = params.credentials.searxngEndpoint?.trim().replace(/\/+$/, "");
	if (!endpoint) {
		throw new SearchProviderError(
			"searxng",
			"SearXNG requires a search endpoint. Set SEARXNG_ENDPOINT, e.g. https://searx.be",
			401,
		);
	}

	const parsed = params.parsedQuery;
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const base = parsed.hasDirectives ? formatQuery(parsed, QUERY_SYNTAX) : params.query;

	const url = new URL(`${endpoint}/search`);
	url.searchParams.set("format", "json");
	url.searchParams.set("q", stripBangs(base) || params.query);
	url.searchParams.set("categories", "general");
	url.searchParams.set("safesearch", "0");
	if (params.recency) url.searchParams.set("time_range", RECENCY_TO_WINDOW[params.recency]);
	const lang = parsed.lang?.split("-")[0];
	if (lang && /^[a-z]{2}$/.test(lang)) url.searchParams.set("language", lang);

	const response = await params.fetchImpl(url.toString(), {
		headers: { Accept: "application/json" },
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	// A self-hosted instance with the JSON format disabled answers with HTML;
	// `readJson` reports that, but a challenge page deserves a sharper message.
	const text = await response.clone().text();
	if (isChallengeBody(text)) {
		throw new SearchProviderError(
			"searxng",
			"SearXNG answered with an anti-bot challenge. Use a self-hosted instance or add an auth token proxy.",
			429,
		);
	}

	const payload = await readJson("searxng", response);
	const { sources, answer, suggestions, unresponsive } = parseSearxng(payload, limit);

	if (sources.length === 0 && unresponsive.length > 0) {
		throw new SearchProviderError(
			"searxng",
			`SearXNG returned no results; upstream engines failed: ${unresponsive.slice(0, 5).join(", ")}.`,
			503,
		);
	}
	if (sources.length === 0) throw new SearchProviderError("searxng", "SearXNG returned no results.", 204);

	return {
		provider: "searxng",
		sources,
		...(answer ? { answer } : {}),
		...(suggestions.length > 0 ? { relatedQuestions: suggestions } : {}),
		authMode: "keyless",
	};
}

export const searxngProvider: SearchProvider = {
	id: "searxng",
	label: "SearXNG",
	isAvailable: (credentials) => Boolean(credentials.searxngEndpoint),
	search: (params) => searchSearxng(params),
};

export const SearXNGProvider = searxngProvider;
