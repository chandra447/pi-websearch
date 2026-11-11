/**
 * Parallel — keyless MCP by default, billed REST API when `PARALLEL_API_KEY` is set.
 *
 * Strongest free backend available to this extension: a real search service
 * (own index, excerpt extraction, `search_id`) rather than a scraped SERP, and
 * its public MCP endpoint answers without credentials.
 *
 * Source-policy mapping follows omp: `site:` becomes an allow-list,
 * `-site:` an exclude-list (sent only when there is no allow-list, because
 * Parallel ignores exclusions when inclusions are present), and `after:`
 * beats relative `recency`.
 */

import type { StructuredQuery } from "../query.ts";
import { formatQuery, recencyAfterDate } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { callMcpTool, mcpJsonPayload } from "./mcp.ts";
import {
	clampNumResults,
	clipSnippet,
	readJson,
	siteHosts,
	toIsoDate,
	toSearchSources,
	withHardTimeout,
} from "./utils.ts";

const MCP_URL = "https://search.parallel.ai/mcp";
const REST_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** REST accepts a natural-language objective; field operators belong in client filters. */
const REST_QUERY_SYNTAX = { phrases: true, negation: true, or: true } as const;
/** The public MCP accepts the wider scraper operator set inline. */
const MCP_QUERY_SYNTAX = { phrases: true, negation: true, or: true, site: true, dateRange: true } as const;

interface ParallelSourcePolicy {
	include_domains?: string[];
	exclude_domains?: string[];
	after_date?: string;
}

function toSourcePolicy(parsed: StructuredQuery, recency: SearchParams["recency"]): ParallelSourcePolicy | undefined {
	const policy: ParallelSourcePolicy = {};
	const include = siteHosts(parsed.sites);
	const exclude = siteHosts(parsed.excludedSites);
	if (include.length) policy.include_domains = include;
	else if (exclude.length) policy.exclude_domains = exclude;
	if (parsed.after) policy.after_date = parsed.after;
	else if (recency) policy.after_date = recencyAfterDate(recency);
	return policy.include_domains || policy.exclude_domains || policy.after_date ? policy : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalize a Parallel payload. The REST API and the MCP tool return the same
 * `results[]` shape (`url`, `title`, `publish_date`, `excerpts[].text`), so one
 * parser serves both and only the transport differs.
 */
function parseParallelPayload(payload: unknown, limit: number): { sources: SearchSource[]; requestId?: string } {
	if (!isRecord(payload)) return { sources: [] };
	const rows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.data) ? payload.data : [];

	const sources: Partial<SearchSource>[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		// `excerpts` arrives as plain strings from the MCP tool and as `{text}`
		// objects from some REST builds; both shapes must survive.
		const excerpt = Array.isArray(row.excerpts)
			? row.excerpts
					.map((entry) =>
						typeof entry === "string"
							? entry
							: isRecord(entry) && typeof entry.text === "string"
								? entry.text
								: "",
					)
					.filter(Boolean)
					.join(" … ")
			: typeof row.snippet === "string"
				? row.snippet
				: undefined;
		sources.push({
			title: typeof row.title === "string" ? row.title : undefined,
			url: typeof row.url === "string" ? row.url : undefined,
			snippet: clipSnippet(excerpt),
			publishedDate: toIsoDate(
				typeof row.publish_date === "string" || typeof row.publish_date === "number"
					? row.publish_date
					: typeof row.publishedDate === "string"
						? row.publishedDate
						: undefined,
			),
		});
	}

	const requestId =
		typeof payload.search_id === "string"
			? payload.search_id
			: typeof payload.requestId === "string"
				? payload.requestId
				: undefined;

	return { sources: toSearchSources(sources, limit), ...(requestId ? { requestId } : {}) };
}

async function searchKeyless(params: SearchParams, query: string, limit: number): Promise<SearchResponse> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const result = await callMcpTool({
		url: MCP_URL,
		provider: "parallel",
		tool: "web_search",
		args: { objective: query, search_queries: [query] },
		fetchImpl: params.fetchImpl,
		signal,
	});
	const { sources, requestId } = parseParallelPayload(mcpJsonPayload(result), limit);
	if (sources.length === 0) {
		// A 200 with no results is not a usable answer; let the chain advance.
		throw new SearchProviderError("parallel", "Parallel returned no results.", 204);
	}
	return { provider: "parallel", sources, authMode: "keyless", ...(requestId ? { requestId } : {}) };
}

async function searchRest(params: SearchParams, query: string, limit: number): Promise<SearchResponse> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const sourcePolicy = toSourcePolicy(params.parsedQuery, params.recency);
	const response = await params.fetchImpl(REST_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-key": params.credentials.parallel ?? "",
			"parallel-beta": PARALLEL_BETA_HEADER,
		},
		body: JSON.stringify({
			objective: query,
			search_queries: [query],
			mode: "fast",
			excerpts: { max_chars_per_result: 1200 },
			...(sourcePolicy ? { source_policy: sourcePolicy } : {}),
		}),
		signal,
	});

	const payload = await readJson("parallel", response);
	const { sources, requestId } = parseParallelPayload(payload, limit);
	return { provider: "parallel", sources, authMode: "api_key", ...(requestId ? { requestId } : {}) };
}

export const parallelProvider: SearchProvider = {
	id: "parallel",
	label: "Parallel",
	// Always available: no credential means the public MCP path.
	isAvailable: () => true,

	async search(params: SearchParams): Promise<SearchResponse> {
		const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
		const parsed = params.parsedQuery;
		if (params.credentials.parallel) {
			const query = parsed.hasDirectives ? formatQuery(parsed, REST_QUERY_SYNTAX) : params.query;
			return searchRest(params, query, limit);
		}
		const query = parsed.hasDirectives ? formatQuery(parsed, MCP_QUERY_SYNTAX) : params.query;
		return searchKeyless(params, query, limit);
	},
};

/** Registry-compatible alias; the registry index imports the PascalCase name. */
export const ParallelProvider = parallelProvider;
