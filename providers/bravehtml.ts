/**
 * Brave Search — the HTML front end, no API key.
 *
 * Distinct from `brave.ts`, which is the paid JSON API. The HTML page needs no
 * credential and, unlike every other keyless engine tested, answered HTTP 200
 * with ~260 KB of server-rendered results from a shared/VPN egress IP. It is
 * therefore the most reliable keyless fallback on a hostile network — but it is
 * also the most fragile to markup drift, since Brave ships a compiled Svelte
 * app whose class names carry build hashes.
 *
 * Parsing is anchored on stable, hash-free markers only:
 *   - `data-type="web"` marks an organic result block (news/video blocks carry
 *     other types);
 *   - the first absolute `<a href>` inside the block is the target;
 *   - `.search-snippet-title` carries the title plus a `title=` attribute;
 *   - `.generic-snippet` / `.snippet-description` carries the excerpt.
 *
 * Every anchor in a block is duplicated by an inner hydration wrapper, so
 * results are de-duplicated by URL downstream.
 */

import { formatScraperQuery, parseSearchQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { BROWSER_HEADERS, decodeHtmlText, readBodyCapped } from "./html.ts";
import { clampNumResults, clipSnippet, isChallengeBody, toSearchSources, withHardTimeout } from "./utils.ts";

const SEARCH_URL = "https://search.brave.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_PAGES = 3;

/** Brave's HTML front end parses the full human operator set. */
const BRAVE_HTML_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	filetype: true,
	inTitle: true,
	inUrl: true,
} as const;

/** Brave's freshness filter (`tf`) as used by its own web UI. */
const RECENCY_TO_TF: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

/** Split the page into per-result segments on the stable type marker. */
function splitResultBlocks(html: string): string[] {
	return html.split(/data-type="web"/).slice(1);
}

/** Title candidates, most specific first. */
function extractTitle(block: string): string | undefined {
	const titleDiv = /<div\b[^>]*\bclass="[^"]*\bsearch-snippet-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
	if (titleDiv) {
		const text = decodeHtmlText(titleDiv[1]);
		if (text) return text;
		return decodeHtmlText(/\btitle="([^"]*)"/i.exec(titleDiv[0])?.[1] ?? "") || undefined;
	}
	// Fall back to the `title=` attribute some layouts put on the container.
	const attr = /\bclass="[^"]*\btitle\b[^"]*"[^>]*\btitle="([^"]+)"/i.exec(block)?.[1];
	return attr ? decodeHtmlText(attr) : undefined;
}

/** Snippet candidates, most specific first. */
function extractSnippet(block: string): string | undefined {
	const selectors = [
		/<div\b[^>]*\bclass="[^"]*\bgeneric-snippet\b[^"]*"[^>]*>[\s\S]*?<div\b[^>]*\bclass="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		/<div\b[^>]*\bclass="[^"]*\bsnippet-description\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		/<div\b[^>]*\bclass="[^"]*\bsnippet-content\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
	];
	for (const pattern of selectors) {
		const match = pattern.exec(block);
		if (!match) continue;
		const text = decodeHtmlText(match[1]);
		if (text) return text;
	}
	return undefined;
}

/** First absolute outbound link in a block; Brave does not wrap clicks. */
function extractUrl(block: string): string | undefined {
	for (const tag of block.match(/<a\b[^>]*>/gi) ?? []) {
		const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
		if (!href) continue;
		const decoded = decodeHtmlText(href);
		if (!/^https?:\/\//i.test(decoded)) continue;
		let host: string;
		try {
			host = new URL(decoded).hostname;
		} catch {
			continue;
		}
		// Skip Brave's own chrome (favicon proxy, share links, breadcrumbs).
		if (host.endsWith("search.brave.com") || host.endsWith("imgs.search.brave.com")) continue;
		return decoded;
	}
	return undefined;
}

export function parseBraveHtml(html: string, limit: number): SearchSource[] {
	const raw: Partial<SearchSource>[] = [];
	for (const block of splitResultBlocks(html)) {
		// Only segments that still carry a title belong to an organic result;
		// hydration wrappers and trailing markup do not.
		const title = extractTitle(block);
		if (!title) continue;
		const url = extractUrl(block);
		if (!url) continue;
		const snippet = extractSnippet(block);
		raw.push({ title, url, ...(snippet ? { snippet: clipSnippet(snippet) } : {}) });
		if (raw.length >= limit * 2) break;
	}
	return toSearchSources(raw, limit);
}

export function buildBraveHtmlUrl(params: SearchParams, offset: number): string {
	const url = new URL(SEARCH_URL);
	url.searchParams.set(
		"q",
		params.parsedQuery.hasDirectives
			? formatScraperQuery(params.parsedQuery, BRAVE_HTML_QUERY_SYNTAX)
			: params.query,
	);
	if (offset > 0) url.searchParams.set("offset", String(offset));
	const tf = params.recency ? RECENCY_TO_TF[params.recency] : undefined;
	if (tf) url.searchParams.set("tf", tf);
	return url.toString();
}

export async function searchBraveHtml(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();

	for (let page = 0; page < MAX_PAGES && sources.length < limit; page++) {
		const response = await params.fetchImpl(buildBraveHtmlUrl(params, page), {
			method: "GET",
			headers: { ...BROWSER_HEADERS, Referer: "https://search.brave.com/" },
			signal,
			redirect: "follow",
		});
		const html = await readBodyCapped(response);

		if (!response.ok) {
			throw new SearchProviderError(
				"bravehtml",
				`Brave Search HTML returned HTTP ${response.status}.`,
				response.status,
			);
		}
		if (isChallengeBody(html)) {
			throw new SearchProviderError(
				"bravehtml",
				"Brave Search HTML blocked the request with an anti-bot challenge.",
				429,
			);
		}

		const before = sources.length;
		for (const source of parseBraveHtml(html, limit)) {
			if (seen.has(source.url)) continue;
			seen.add(source.url);
			sources.push(source);
			if (sources.length >= limit) break;
		}
		if (sources.length === before) break;
	}

	if (sources.length === 0) {
		throw new SearchProviderError("bravehtml", "Brave Search HTML returned no parseable results.", 204);
	}

	return { provider: "bravehtml", sources: sources.slice(0, limit), authMode: "keyless" };
}

export class BraveHtmlProvider implements SearchProvider {
	readonly id = "bravehtml";
	readonly label = "Brave (HTML)";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBraveHtml(params);
	}
}

/** Convenience for one-off callers and the probe harness. */
export function searchBraveHtmlRaw(query: string, limit = DEFAULT_NUM_RESULTS): ReturnType<typeof searchBraveHtml> {
	return searchBraveHtml({
		query,
		parsedQuery: parseSearchQuery(query),
		limit,
		timeoutMs: 20_000,
		credentials: {},
		config: {
			chain: [],
			disabled: [],
			timeoutSeconds: 20,
			defaultLimit: 10,
			maxLimit: 20,
			recency: null,
			source: "default",
			warnings: [],
		},
		fetchImpl: fetch,
	});
}
