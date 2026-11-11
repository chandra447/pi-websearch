/**
 * Kagi Search API (V1).
 *
 * Kagi answers in categorized buckets (`search`, `news`, `video`, infobox,
 * adjacent questions, direct answer) rather than a flat list, and gates
 * quality behind a paid subscription — so it is the strongest single source
 * when the user has a key and simply unavailable otherwise.
 *
 * `KAGI_API_KEY` is read straight from the environment because `Credentials`
 * in `config.ts` predates this provider; folding it in there is a separate,
 * additive change to a file this provider does not own.
 */

import { formatQuery, type QuerySyntax } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { clampNumResults, clipSnippet, readJson, toIsoDate, withHardTimeout } from "./utils.ts";

const API_URL = "https://kagi.com/api/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;
const SNIPPET_CHARS = 400;

/** Kagi's index parses the classic Google operator set inline. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Key from the orchestrator-resolved credentials (config file or KAGI_API_KEY). */
function kagiKey(params: SearchParams): string | undefined {
	const value = params.credentials.kagi?.trim();
	return value || undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/** UTC `YYYY-MM-DD` lower bound `recency` units before now. */
function recencyDate(recency: "day" | "week" | "month" | "year"): string {
	const date = new Date();
	if (recency === "day") date.setUTCDate(date.getUTCDate() - 1);
	else if (recency === "week") date.setUTCDate(date.getUTCDate() - 7);
	else if (recency === "month") date.setUTCMonth(date.getUTCMonth() - 1);
	else date.setUTCFullYear(date.getUTCFullYear() - 1);
	return date.toISOString().slice(0, 10);
}

function collect(bucket: unknown, into: SearchSource[], tag?: string): void {
	if (!Array.isArray(bucket)) return;
	for (const value of bucket) {
		if (!isRecord(value)) continue;
		const url = firstString(value.url, value.href, value.link);
		if (!url) continue;
		const title = firstString(value.title, value.name) ?? url;
		const snippet = clipSnippet(firstString(value.snippet, value.description, value.summary), SNIPPET_CHARS);
		const published = toIsoDate(firstString(value.time));
		into.push({
			title: tag ? `${tag} ${title}` : title,
			url,
			...(snippet ? { snippet } : {}),
			...(published ? { publishedDate: published } : {}),
		});
	}
}

function questionOf(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const props = isRecord(value.props) ? value.props : undefined;
	return firstString(props?.question, props?.query, value.title);
}

export async function searchKagi(params: SearchParams): Promise<SearchResponse> {
	const key = kagiKey(params);
	if (!key) {
		throw new SearchProviderError("kagi", "Kagi requires an API key. Set KAGI_API_KEY.", 401);
	}

	const parsed = params.parsedQuery;
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	// Kagi's index parses the classic Google operator set inline.
	const query = parsed.hasDirectives ? formatQuery(parsed, QUERY_SYNTAX) : params.query.trim();

	const body: Record<string, unknown> = { query, workflow: "search", limit };
	const filters: { after?: string; before?: string } = {};
	if (parsed.after) filters.after = parsed.after;
	else if (params.recency) filters.after = recencyDate(params.recency);
	if (parsed.before) filters.before = parsed.before;
	if (filters.after || filters.before) body.filters = filters;

	const response = await params.fetchImpl(API_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const payload = await readJson("kagi", response);
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};

	const sources: SearchSource[] = [];
	collect(data.search, sources);
	collect(data.video, sources, "[video]");
	collect(data.news, sources, "[news]");
	collect(data.infobox, sources, "[infobox]");

	if (sources.length === 0) throw new SearchProviderError("kagi", "Kagi returned no results.", 204);

	const direct = Array.isArray(data.direct_answer) ? data.direct_answer[0] : undefined;
	const answer = isRecord(direct) ? firstString(direct.snippet, direct.title) : undefined;

	const related: string[] = [];
	for (const bucket of [data.adjacent_question, data.related_search]) {
		if (!Array.isArray(bucket)) continue;
		for (const item of bucket) {
			const question = questionOf(item);
			if (question) related.push(question);
		}
	}

	const meta = isRecord(payload) && isRecord(payload.meta) ? payload.meta : undefined;
	const trace = firstString(meta?.trace);

	return {
		provider: "kagi",
		sources: sources.slice(0, limit),
		...(answer ? { answer } : {}),
		...(related.length > 0 ? { relatedQuestions: related.slice(0, 8) } : {}),
		...(trace ? { requestId: trace } : {}),
		authMode: "api_key",
	};
}

export const kagiProvider: SearchProvider = {
	id: "kagi",
	label: "Kagi",
	isAvailable: (credentials) => Boolean(credentials.kagi),
	search: (params) => searchKagi(params),
};

export const KagiProvider = kagiProvider;
