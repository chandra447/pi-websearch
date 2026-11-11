/**
 * Brave Search API — an independent crawl, not a Google reseller.
 *
 * That independence is the point: when the chain is mostly Google-derived
 * results (Bing, Startpage, DDG), Brave is the one candidate that can surface
 * a page the others buried. It parses the classic operator set inline, so
 * directives stay in the query and only date bounds map onto `freshness`.
 */

import { formatQuery, type QuerySyntax, type StructuredQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import {
	clampNumResults,
	clipSnippet,
	readJson,
	toIsoDate,
	toSearchSources,
	withHardTimeout,
} from "./utils.ts";

const API_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_QUERY_CHARACTERS = 400;
const SNIPPET_CHARS = 400;

const RECENCY_TO_FRESHNESS: Record<"day" | "week" | "month" | "year", "pd" | "pw" | "pm" | "py"> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/** Brave parses the classic operator set inline; date bounds ride in `freshness`. */
const QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	inUrl: true,
	inTitle: true,
	inText: true,
	filetype: true,
	dateRange: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);

/** One page is one result: drop tracking params and the fragment for the deduper. */
function canonicalUrl(raw: string): string {
	try {
		const url = new URL(raw);
		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return raw;
	}
}

/**
 * `freshness`: an explicit `after:`/`before:` pair becomes an absolute range;
 * otherwise the relative recency window wins.
 */
export function braveFreshness(
	parsed: StructuredQuery,
	recency?: "day" | "week" | "month" | "year",
): string | undefined {
	if (parsed.after || parsed.before) {
		const start = parsed.after ?? "1970-01-01";
		const end = parsed.before ?? new Date().toISOString().slice(0, 10);
		return `${start}to${end}`;
	}
	return recency ? RECENCY_TO_FRESHNESS[recency] : undefined;
}

function parseBrave(payload: unknown, limit: number) {
	const web = isRecord(payload) && isRecord(payload.web) ? payload.web : undefined;
	const rows = web && Array.isArray(web.results) ? web.results : [];
	const raw = rows.filter(isRecord).map((row) => {
		const extras = Array.isArray(row.extra_snippets)
			? row.extra_snippets.find((entry): entry is string => typeof entry === "string")
			: undefined;
		const snippet = clipSnippet(
			[typeof row.description === "string" ? row.description : "", extras ?? ""].filter(Boolean).join(" "),
			SNIPPET_CHARS,
		);
		const published = toIsoDate(typeof row.page_age === "string" ? row.page_age : undefined);
		const href = typeof row.url === "string" ? row.url : undefined;
		return {
			title: typeof row.title === "string" ? row.title : undefined,
			url: href ? canonicalUrl(href) : undefined,
			snippet,
			...(published ? { publishedDate: published } : {}),
		};
	});
	return toSearchSources(raw, limit);
}

export async function searchBrave(params: SearchParams): Promise<SearchResponse> {
	const key = params.credentials.brave;
	if (!key) {
		throw new SearchProviderError("brave", "Brave requires an API key. Set BRAVE_API_KEY.", 401);
	}

	const parsed = params.parsedQuery;
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const query = parsed.hasDirectives ? formatQuery(parsed, QUERY_SYNTAX) : params.query.trim();
	if (query.length > MAX_QUERY_CHARACTERS) {
		throw new SearchProviderError(
			"brave",
			`Brave rejects queries over ${MAX_QUERY_CHARACTERS} characters (got ${query.length}).`,
			400,
		);
	}

	const url = new URL(API_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));
	url.searchParams.set("extra_snippets", "true");
	url.searchParams.set("safesearch", "moderate");
	const freshness = braveFreshness(parsed, params.recency);
	if (freshness) url.searchParams.set("freshness", freshness);
	const lang = parsed.lang?.split("-")[0];
	if (lang && /^[a-z]{2}$/.test(lang)) url.searchParams.set("search_lang", lang);

	const response = await params.fetchImpl(url.toString(), {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": key,
		},
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const payload = await readJson("brave", response);
	const sources = parseBrave(payload, limit);
	if (sources.length === 0) throw new SearchProviderError("brave", "Brave returned no results.", 204);
	return { provider: "brave", sources, authMode: "api_key" };
}

export const braveProvider: SearchProvider = {
	id: "brave",
	label: "Brave",
	isAvailable: (credentials) => Boolean(credentials.brave),
	search: (params) => searchBrave(params),
};

export const BraveProvider = braveProvider;
