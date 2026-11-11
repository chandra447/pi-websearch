/**
 * Jina Reader search — `https://s.jina.ai`, credential required.
 *
 * There is no keyless reader for *search* (`r.jina.ai` only reads a URL the
 * caller already has), so unlike the other providers this one is genuinely
 * unavailable without `JINA_API_KEY`: `isAvailable` reports `false` and the
 * automatic chain skips it silently rather than spending a round trip on a
 * guaranteed 401.
 *
 * Jina searches through a Bing-backed index, so the query keeps the standard
 * operator set. A single `site:` host is better expressed with the dedicated
 * `X-Site` header, which turns the call into an in-site search.
 */

import { formatQuery, type QuerySyntax } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { clampNumResults, clipSnippet, siteHosts, toSearchSources, withHardTimeout } from "./utils.ts";

const SEARCH_URL = "https://s.jina.ai/";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

/** Bing-backed: everything except the site operator, which moves to a header. */
const JINA_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	dateRange: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Jina answers with a bare array, or with `{ code, data }` on newer builds.
 * A non-200 `code` inside a 200 response is still a failure.
 */
function parseJinaPayload(payload: unknown): Partial<SearchSource>[] {
	let rows: unknown[] = [];
	if (Array.isArray(payload)) {
		rows = payload;
	} else if (isRecord(payload)) {
		if (typeof payload.code === "number" && payload.code !== 200) {
			const message = typeof payload.message === "string" ? payload.message : `code ${payload.code}`;
			throw new SearchProviderError("jina", `Jina reported a failure: ${message}`, payload.code);
		}
		if (Array.isArray(payload.data)) rows = payload.data;
	}

	return rows.filter(isRecord).map((row) => ({
		title: typeof row.title === "string" ? row.title : undefined,
		url: typeof row.url === "string" ? row.url : undefined,
		snippet: clipSnippet(
			typeof row.description === "string"
				? row.description
				: typeof row.content === "string"
					? row.content
					: undefined,
		),
		// Jina's reader reports a page timestamp when it has one.
		publishedDate: typeof row.timestamp === "string" ? row.timestamp : undefined,
	}));
}

export async function searchJina(params: SearchParams): Promise<SearchResponse> {
	const key = params.credentials.jina;
	if (!key) {
		throw new SearchProviderError(
			"jina",
			"Jina requires an API key. Set JINA_API_KEY to enable it.",
			401,
		);
	}

	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { parsedQuery } = params;
	const hosts = siteHosts(parsedQuery.sites);
	// One host becomes an in-site search; several would need one call each, so
	// they stay inline in the query and the post-filter enforces them.
	const site = hosts.length === 1 ? hosts[0] : undefined;
	const query = parsedQuery.hasDirectives
		? formatQuery(parsedQuery, site ? { ...JINA_QUERY_SYNTAX, site: false } : JINA_QUERY_SYNTAX)
		: params.query.trim();

	const requestUrl = new URL(encodeURIComponent(query), SEARCH_URL);
	requestUrl.searchParams.set("count", String(limit));

	const response = await params.fetchImpl(requestUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${key}`,
			// Cleaned page text is charged by length; a snippet does not need it.
			"X-Respond-With": "no-content",
			"X-Retain-Images": "none",
			...(site ? { "X-Site": site } : {}),
		},
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const text = await response.text();
	if (!response.ok) {
		const classified = classifyJinaStatus(response.status, text);
		if (classified) throw classified;
		throw new SearchProviderError("jina", `Jina returned HTTP ${response.status}.`, response.status);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new SearchProviderError("jina", "Jina returned a non-JSON response.", response.status);
	}

	const sources = toSearchSources(parseJinaPayload(payload), limit);
	if (sources.length === 0) throw new SearchProviderError("jina", "Jina returned no results.", 204);
	return { provider: "jina", sources, authMode: "api_key" };
}

/** Jina's own 401 body names the problem more usefully than the status alone. */
function classifyJinaStatus(status: number, body: string): SearchProviderError | undefined {
	if (status !== 401 && status !== 402 && status !== 403 && status !== 429) return undefined;
	let detail = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed) && typeof parsed.message === "string") detail = ` ${parsed.message.trim()}`;
	} catch {
		// non-JSON body; the status alone is enough
	}
	return new SearchProviderError("jina", `Jina authorization failed (${status}).${detail}`, status);
}

export const jinaProvider: SearchProvider = {
	id: "jina",
	label: "Jina",
	// No keyless search endpoint exists, so the chain must skip this provider
	// rather than burn the request on a guaranteed 401.
	isAvailable: (credentials) => Boolean(credentials.jina),

	search(params: SearchParams): Promise<SearchResponse> {
		return searchJina(params);
	},
};

/** Registry-compatible alias; the registry index imports the PascalCase name. */
export const JinaProvider = jinaProvider;
