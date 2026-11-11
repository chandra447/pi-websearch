/**
 * Tavily — the most agent-shaped of the paid APIs.
 *
 * It returns short dense `content` excerpts plus an optional synthesized
 * `answer`, and exposes domain + time filters as native fields rather than
 * query operators. `time_range` is kept as a pure time filter: `topic` is
 * never set, because narrowing a technical query to news is almost always
 * wrong when the caller only asked for fresher pages.
 */

import { formatQuery, type QuerySyntax } from "../query.ts";
import { SearchProviderError, type SearchResponse } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import {
	clampNumResults,
	clipSnippet,
	readJson,
	siteHosts,
	toIsoDate,
	toSearchSources,
	withHardTimeout,
} from "./utils.ts";

const API_URL = "https://api.tavily.com/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
/** Tavily excerpts run to several KB; bound them at parse time. */
const SNIPPET_CHARS = 1000;

/** Tavily takes natural language: everything with a native field is stripped from the query. */
const QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, or: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function buildQuery(params: SearchParams): string {
	const parsed = params.parsedQuery;
	return parsed.hasDirectives ? formatQuery(parsed, QUERY_SYNTAX) : params.query.trim();
}

function buildBody(params: SearchParams, limit: number): Record<string, unknown> {
	const parsed = params.parsedQuery;
	const body: Record<string, unknown> = {
		query: buildQuery(params),
		max_results: limit,
		search_depth: "basic",
		include_answer: true,
	};

	const include = siteHosts(parsed.sites);
	const exclude = siteHosts(parsed.excludedSites);
	if (include.length) body.include_domains = include;
	else if (exclude.length) body.exclude_domains = exclude;

	// Absolute bounds win over the relative window so the two cannot disagree.
	if (parsed.after) body.start_date = parsed.after;
	if (parsed.before) body.end_date = parsed.before;
	if (!parsed.after && !parsed.before && params.recency) body.time_range = params.recency;

	return body;
}

function parseTavily(payload: unknown, limit: number) {
	const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
	const raw = rows.filter(isRecord).map((row) => {
		const published = toIsoDate(typeof row.published_date === "string" ? row.published_date : undefined);
		return {
			title: typeof row.title === "string" ? row.title : undefined,
			url: typeof row.url === "string" ? row.url : undefined,
			snippet: clipSnippet(typeof row.content === "string" ? row.content : undefined, SNIPPET_CHARS),
			...(published ? { publishedDate: published } : {}),
		};
	});
	const answer = isRecord(payload) && typeof payload.answer === "string" ? payload.answer.trim() : "";
	const requestId = isRecord(payload) && typeof payload.request_id === "string" ? payload.request_id : undefined;
	return { sources: toSearchSources(raw, limit), answer, requestId };
}

export async function searchTavily(params: SearchParams): Promise<SearchResponse> {
	const key = params.credentials.tavily;
	if (!key) {
		throw new SearchProviderError(
			"tavily",
			"Tavily requires an API key. Set TAVILY_API_KEY.",
			401,
		);
	}

	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const send = async (body: Record<string, unknown>): Promise<unknown> => {
		const response = await params.fetchImpl(API_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
			},
			body: JSON.stringify(body),
			signal,
		});
		return readJson("tavily", response);
	};

	const body = buildBody(params, limit);
	let { sources, answer, requestId } = parseTavily(await send(body), limit);

	// A window too narrow for the query returns zero rows; retry once unfiltered
	// rather than reporting a dead search.
	if (sources.length === 0 && (body.time_range || body.start_date || body.end_date)) {
		const retry = { ...body };
		delete retry.time_range;
		delete retry.start_date;
		delete retry.end_date;
		({ sources, answer, requestId } = parseTavily(await send(retry), limit));
	}

	if (sources.length === 0) throw new SearchProviderError("tavily", "Tavily returned no results.", 204);

	return {
		provider: "tavily",
		sources,
		...(answer ? { answer } : {}),
		...(requestId ? { requestId } : {}),
		authMode: "api_key",
	};
}

export const tavilyProvider: SearchProvider = {
	id: "tavily",
	label: "Tavily",
	isAvailable: (credentials) => Boolean(credentials.tavily),
	search: (params) => searchTavily(params),
};

export const TavilyProvider = tavilyProvider;
