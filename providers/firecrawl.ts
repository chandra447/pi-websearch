/**
 * Firecrawl — keyed when `FIRECRAWL_API_KEY` is set, keyless search otherwise.
 *
 * Keyless mode is genuinely supported (`authMode: "keyless"`) but Firecrawl
 * applies IP reputation to it: a shared, datacenter or VPN egress address is
 * refused with a 403 that says so explicitly. That refusal is surfaced as a
 * 403 provider error so the chain advances instead of retrying into the same
 * wall.
 *
 * The index is SERP-backed, so the query keeps the full Google operator set and
 * absolute date bounds move to the native `tbs` custom-range parameter.
 */

import { formatQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { clampNumResults, clipSnippet, readJson, toSearchSources, withHardTimeout } from "./utils.ts";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

/** Firecrawl's search endpoint is SERP-backed and parses the whole operator set. */
const SERP_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	dateRange: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
} as const;

const RECENCY_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Resolve the search endpoint, honouring the `FIRECRAWL_BASE_URL` (or legacy
 * `FIRECRAWL_API_URL`) self-hosting override. A configured origin keeps an
 * explicit `/v1` or `/v2` suffix and otherwise defaults to `/v2`.
 */
export function resolveFirecrawlUrl(endpoint: "/search"): string {
	const configured = process.env.FIRECRAWL_BASE_URL ?? process.env.FIRECRAWL_API_URL;
	if (!configured?.trim()) return `${DEFAULT_BASE_URL}${endpoint}`;

	let url: URL;
	try {
		url = new URL(configured.trim());
	} catch {
		throw new SearchProviderError("firecrawl", "Invalid Firecrawl base URL: expected an HTTP or HTTPS URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SearchProviderError("firecrawl", "Invalid Firecrawl base URL: expected an HTTP or HTTPS URL.");
	}
	if (url.username || url.password) {
		throw new SearchProviderError("firecrawl", "Invalid Firecrawl base URL: URL credentials are not allowed.");
	}
	url.search = "";
	url.hash = "";
	// Assigning "" to pathname normalizes back to "/", so build the path locally.
	let basePath = url.pathname.replace(/\/+$/, "");
	if (!/\/v[12]$/i.test(basePath)) basePath += "/v2";
	url.pathname = `${basePath}${endpoint}`;
	return url.toString();
}

/** ISO `YYYY-MM-DD` -> Google's `MM/DD/YYYY`. */
function toGoogleDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	return `${month}/${day}/${year}`;
}

/**
 * Absolute `after:`/`before:` bounds become a native custom date range, which
 * takes precedence over the relative `recency` window.
 */
function buildTbs(params: SearchParams): string | undefined {
	const { after, before } = params.parsedQuery;
	if (after || before) {
		const parts = ["cdr:1"];
		if (after) parts.push(`cd_min:${toGoogleDate(after)}`);
		if (before) parts.push(`cd_max:${toGoogleDate(before)}`);
		return parts.join(",");
	}
	return params.recency ? RECENCY_TBS[params.recency] : undefined;
}

/** v2 nests results under `data.web`; older shapes use a flat array or `results`. */
function webResults(payload: unknown): Partial<SearchSource>[] {
	if (!isRecord(payload)) return [];
	const rows = Array.isArray(payload.data)
		? payload.data
		: isRecord(payload.data) && Array.isArray(payload.data.web)
			? payload.data.web
			: Array.isArray(payload.results)
				? payload.results
				: [];
	return rows.filter(isRecord).map((row) => ({
		title: typeof row.title === "string" ? row.title : undefined,
		url: typeof row.url === "string" ? row.url : undefined,
		// `description` is the SERP snippet; `markdown` is a fallback for results
		// that carry scraped content instead.
		snippet: clipSnippet(
			typeof row.description === "string"
				? row.description
				: typeof row.snippet === "string"
					? row.snippet
					: typeof row.markdown === "string"
						? row.markdown
						: undefined,
		),
	}));
}

export async function searchFirecrawl(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const key = params.credentials.firecrawl;
	const tbs = buildTbs(params);

	// The query keeps the operators Firecrawl parses; the date bounds it cannot
	// read from the text are carried by `tbs` instead.
	const query = params.parsedQuery.hasDirectives
		? formatQuery(params.parsedQuery, tbs ? { ...SERP_QUERY_SYNTAX, dateRange: false } : SERP_QUERY_SYNTAX)
		: params.query.trim();

	const response = await params.fetchImpl(resolveFirecrawlUrl("/search"), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify({
			query,
			limit,
			sources: [{ type: "web" }],
			...(tbs ? { tbs } : {}),
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const payload = await readJson("firecrawl", response);
	// A 200 can still carry a structured refusal.
	if (isRecord(payload) && payload.success === false) {
		const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : undefined;
		throw new SearchProviderError("firecrawl", message ?? "Firecrawl reported the request as unsuccessful.");
	}

	const sources = toSearchSources(webResults(payload), limit);
	if (sources.length === 0) throw new SearchProviderError("firecrawl", "Firecrawl returned no results.", 204);

	const requestId = isRecord(payload) && typeof payload.id === "string" ? payload.id : undefined;
	return {
		provider: "firecrawl",
		sources,
		authMode: key ? "api_key" : "keyless",
		...(requestId ? { requestId } : {}),
	};
}

export const firecrawlProvider: SearchProvider = {
	id: "firecrawl",
	label: "Firecrawl",
	// Always available: without a key, search runs in keyless mode.
	isAvailable: () => true,

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl(params);
	},
};

/** Registry-compatible alias; the registry index imports the PascalCase name. */
export const FirecrawlProvider = firecrawlProvider;
