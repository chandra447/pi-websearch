/**
 * Exa — keyed neural search when `EXA_API_KEY` is set, public MCP otherwise.
 *
 * Two transports behind one provider id:
 *   - keyed   -> POST `https://api.exa.ai/search`, which returns titles, page
 *     dates and per-result text.
 *   - keyless -> the credential-free `web_search_exa` MCP tool, which is not
 *     IP-walled the way the HTML frontends are, making it the most reliable
 *     zero-credential backend available to this extension.
 *
 * A configured key that fails is surfaced as a real error and never silently
 * downgraded to the keyless endpoint: a user who exported `EXA_API_KEY` needs
 * to know it is broken, not to receive unauthenticated results unannounced.
 *
 * The MCP tool answers with a *plain-text* blob rather than JSON, so it cannot
 * go through `mcpJsonPayload` — the blocks are read directly and parsed by
 * {@link parseExaTextBlob}.
 */

import type { StructuredQuery } from "../query.ts";
import { formatQuery, recencyAfterDate } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { callMcpTool, type McpToolResult } from "./mcp.ts";
import {
	clipSnippet,
	clampNumResults,
	readJson,
	siteHosts,
	toIsoDate,
	toSearchSources,
	withHardTimeout,
} from "./utils.ts";

const API_URL = "https://api.exa.ai/search";
const MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
/** Exa returns whole pages; keep enough for a useful snippet and no more. */
const SNIPPET_CHARS = 500;

/** Exa is neural/keyword — keep quoted phrases, drop operators it reads as literals. */
const NEURAL_QUERY_SYNTAX = { phrases: true } as const;

interface ExaRow {
	title?: string | null;
	url?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	summary?: string | null;
	highlights?: string[] | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Exa rejects `excludeDomains` alongside `includeDomains`; the allow list wins. */
function domainFilter(parsed: StructuredQuery): Record<string, string[]> {
	const include = siteHosts(parsed.sites);
	if (include.length) return { includeDomains: include };
	const exclude = siteHosts(parsed.excludedSites);
	return exclude.length ? { excludeDomains: exclude } : {};
}

function buildQuery(parsed: StructuredQuery, raw: string): string {
	return parsed.hasDirectives ? formatQuery(parsed, NEURAL_QUERY_SYNTAX) : raw.trim();
}

function buildApiBody(params: SearchParams, limit: number): Record<string, unknown> {
	const { parsedQuery } = params;
	const after = parsedQuery.after ?? (params.recency ? recencyAfterDate(params.recency) : undefined);
	return {
		query: buildQuery(parsedQuery, params.query),
		numResults: limit,
		type: "auto",
		contents: { text: { maxCharacters: SNIPPET_CHARS } },
		...domainFilter(parsedQuery),
		...(after ? { startPublishedDate: after } : {}),
		...(parsedQuery.before ? { endPublishedDate: parsedQuery.before } : {}),
	};
}

/**
 * Exa's MCP tool takes free text only, so the constraints the neural index has
 * no field for are re-emitted as operators in the query string — the same
 * mapping omp uses for this endpoint.
 */
function buildMcpArgs(params: SearchParams, limit: number): Record<string, unknown> {
	const { parsedQuery } = params;
	const parts = [buildQuery(parsedQuery, params.query)];
	for (const host of siteHosts(parsedQuery.sites)) parts.push(`site:${host}`);
	for (const host of siteHosts(parsedQuery.excludedSites)) parts.push(`-site:${host}`);
	const after = parsedQuery.after ?? (params.recency ? recencyAfterDate(params.recency) : undefined);
	if (after) parts.push(`after:${after}`);
	if (parsedQuery.before) parts.push(`before:${parsedQuery.before}`);
	return { query: parts.join(" "), numResults: limit };
}

/** One `Label: value` line from an MCP text block; `N/A` means "not reported". */
function readField(section: string, label: string): string | undefined {
	const match = new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`).exec(section);
	const value = match?.[1]?.trim();
	return value && value !== "N/A" ? value : undefined;
}

/** Everything under `Highlights:` is the snippet body. */
function readHighlights(section: string): string | undefined {
	const match = /\nHighlights:\s*\n?([\s\S]*)$/.exec(section);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

/**
 * Parse the MCP text blob. Blocks repeat `Title:`/`URL:`/`Published:`/
 * `Author:`/`Highlights:` and are separated by a `---` rule, though a bare
 * `Title:` at the start of a line also starts one.
 */
export function parseExaTextBlob(blob: string): Partial<SearchSource>[] {
	const sources: Partial<SearchSource>[] = [];
	for (const chunk of blob.split(/\n\s*---\s*\n|\n(?=Title: )/)) {
		const section = chunk.trim();
		if (!section.startsWith("Title:")) continue;
		sources.push({
			title: readField(section, "Title"),
			url: readField(section, "URL"),
			snippet: clipSnippet(readHighlights(section), SNIPPET_CHARS),
			publishedDate: toIsoDate(readField(section, "Published")),
		});
	}
	return sources;
}

/** Narrow an MCP result to its text blocks. */
function textBlocks(result: McpToolResult): string[] {
	return (result.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter(Boolean);
}

function parseApiPayload(payload: unknown): Partial<SearchSource>[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
	return payload.results.filter(isRecord).map((row: ExaRow) => ({
		title: row.title ?? undefined,
		url: row.url ?? undefined,
		snippet: clipSnippet(row.summary ?? row.text ?? row.highlights?.join(" ") ?? undefined, SNIPPET_CHARS),
		publishedDate: toIsoDate(row.publishedDate ?? undefined),
	}));
}

async function searchKeyed(params: SearchParams, limit: number): Promise<SearchResponse> {
	const response = await params.fetchImpl(API_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-key": params.credentials.exa ?? "",
		},
		body: JSON.stringify(buildApiBody(params, limit)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	const payload = await readJson("exa", response);
	const sources = toSearchSources(parseApiPayload(payload), limit);
	if (sources.length === 0) throw new SearchProviderError("exa", "Exa returned no results.", 204);
	const requestId = isRecord(payload) && typeof payload.requestId === "string" ? payload.requestId : undefined;
	return { provider: "exa", sources, authMode: "api_key", ...(requestId ? { requestId } : {}) };
}

async function searchKeyless(params: SearchParams, limit: number): Promise<SearchResponse> {
	const result = await callMcpTool({
		url: MCP_URL,
		provider: "exa",
		tool: "web_search_exa",
		args: buildMcpArgs(params, limit),
		fetchImpl: params.fetchImpl,
		signal: withHardTimeout(params.signal, params.timeoutMs),
		headers: { "x-exa-source": "pi-websearch" },
	});

	const blocks = textBlocks(result);
	const joined = blocks.join("\n\n").trim();
	if (!joined) throw new SearchProviderError("exa", "Exa MCP returned no content.", 204);

	// A newer server build may answer with JSON instead of the text blob.
	const structured = blocks.length === 1 ? safeJson(joined) : undefined;
	const parsed = Array.isArray((structured as { results?: unknown })?.results)
		? parseApiPayload(structured)
		: parseExaTextBlob(joined);

	const sources = toSearchSources(parsed, limit);
	if (sources.length === 0) throw new SearchProviderError("exa", "Exa MCP returned no parseable results.", 204);
	return { provider: "exa", sources, authMode: "keyless" };
}

function safeJson(text: string): unknown {
	if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Dispatch: keyed REST when a credential exists, the public MCP tool otherwise. */
export async function searchExa(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	return params.credentials.exa ? searchKeyed(params, limit) : searchKeyless(params, limit);
}

export const exaProvider: SearchProvider = {
	id: "exa",
	label: "Exa",
	// Always available: without a key, search runs through the public MCP tool.
	isAvailable: () => true,

	search(params: SearchParams): Promise<SearchResponse> {
		return searchExa(params);
	},
};

/** Registry-compatible alias; the registry index imports the PascalCase name. */
export const ExaProvider = exaProvider;
