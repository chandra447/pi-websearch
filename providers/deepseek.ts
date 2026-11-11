/**
 * DeepSeek web search (`/v1/tools/search`).
 *
 * Cheap and strong on technical queries, but its query field is capped at 128
 * characters and it speaks a narrow operator set, so directives are rewritten
 * before dispatch and an over-long query is rejected locally instead of
 * costing a round trip to learn the same thing.
 *
 * `DEEPSEEK_API_KEY` is read straight from the environment because
 * `Credentials` in `config.ts` predates this provider; folding it in there is a
 * separate, additive change to a file this provider does not own.
 */

import { formatQuery, recencyAfterDate, type QuerySyntax } from "../query.ts";
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

const API_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const SNIPPET_CHARS = 400;
/** Hard upstream limit on the query field. */
const MAX_QUERY_CHARACTERS = 128;

/** DeepSeek parses phrases, `-`, `OR`, `site:`, and date bounds. */
const QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, or: true, site: true, dateRange: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Key from the orchestrator-resolved credentials (config file or DEEPSEEK_API_KEY). */
function deepseekKey(params: SearchParams): string | undefined {
	const value = params.credentials.deepseek?.trim();
	return value || undefined;
}

/**
 * Flatten to DeepSeek's operator set: `site:` hosts stay single, `lang:`
 * collapses to its primary subtag, and a relative recency window becomes an
 * absolute `after:` bound unless the query already carries one.
 */
export function buildDeepseekQuery(params: SearchParams): string {
	const parsed = params.parsedQuery;
	let query = parsed.hasDirectives ? formatQuery(parsed, QUERY_SYNTAX) : params.query.trim();

	query = query.replace(/\bsite:(\S+)/gi, (_match, site: string) => {
		const hosts = siteHosts([site]);
		return hosts.length > 0 ? `site:${hosts[0]}` : "";
	});

	if (parsed.lang) {
		const primary = parsed.lang.split("-")[0];
		query = query.replace(/\blang(?:uage)?:\S+/gi, "");
		if (primary) query = `${query} lang:${primary}`;
	}

	if (params.recency && !parsed.after) query = `${query} after:${recencyAfterDate(params.recency)}`;

	return query.replace(/\s+/g, " ").trim();
}

function parseDeepseek(payload: unknown, limit: number) {
	const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
	const raw = rows.filter(isRecord).map((row) => {
		// `summary` is already model-oriented and far denser than `snippet`.
		const snippet = clipSnippet(
			typeof row.summary === "string" ? row.summary : typeof row.snippet === "string" ? row.snippet : undefined,
			SNIPPET_CHARS,
		);
		const published = toIsoDate(typeof row.published_at === "string" ? row.published_at : undefined);
		return {
			title: typeof row.title === "string" ? row.title : undefined,
			url: typeof row.url === "string" ? row.url : undefined,
			snippet,
			...(published ? { publishedDate: published } : {}),
		};
	});
	return toSearchSources(raw, limit);
}

export async function searchDeepseek(params: SearchParams): Promise<SearchResponse> {
	const key = deepseekKey(params);
	if (!key) {
		throw new SearchProviderError("deepseek", "DeepSeek requires an API key. Set DEEPSEEK_API_KEY.", 401);
	}

	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const query = buildDeepseekQuery(params);
	if (!query) throw new SearchProviderError("deepseek", "DeepSeek search needs at least one term.", 400);
	if (query.length > MAX_QUERY_CHARACTERS) {
		throw new SearchProviderError(
			"deepseek",
			`DeepSeek rejects queries over ${MAX_QUERY_CHARACTERS} characters (got ${query.length}). Shorten the query.`,
			400,
		);
	}

	const response = await params.fetchImpl(API_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ query, count: limit }),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const payload = await readJson("deepseek", response);
	const sources = parseDeepseek(payload, limit);
	if (sources.length === 0) throw new SearchProviderError("deepseek", "DeepSeek returned no results.", 204);
	return { provider: "deepseek", sources, authMode: "api_key" };
}

export const deepseekProvider: SearchProvider = {
	id: "deepseek",
	label: "DeepSeek",
	isAvailable: (credentials) => Boolean(credentials.deepseek),
	search: (params) => searchDeepseek(params),
};

export const DeepSeekProvider = deepseekProvider;
