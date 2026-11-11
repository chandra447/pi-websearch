/**
 * Marginalia Search — an independent, non-commercial index. No API key.
 *
 * Deliberately last in any chain. It indexes a small slice of the web (mostly
 * personal sites, forums, old-school documentation) and returns nothing at all
 * for mainstream queries, but for technical or historical questions it surfaces
 * material Google and Bing bury. Treat an empty result as normal, not as a
 * failure to retry.
 *
 * It is gated behind a "Wait For A Moment" interstitial: the first request
 * answers HTTP 200 with a 2-second countdown page carrying an `sst` token and a
 * redirect URL. Replaying the request with that token yields the real SERP. A
 * scraper that does not solve it reports "0 results" forever, so the token step
 * is load-bearing rather than decorative.
 */

import { formatScraperQuery, parseSearchQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { BROWSER_HEADERS, decodeHtmlText, readBodyCapped } from "./html.ts";
import { clampNumResults, clipSnippet, toSearchSources, withHardTimeout } from "./utils.ts";

/** The legacy host is the one that reliably serves 25 results after the token step. */
const SEARCH_HOSTS = ["https://old-search.marginalia.nu", "https://search.marginalia.nu"] as const;
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/** Marginalia is a keyword index with no field operators. */
const MARGINALIA_QUERY_SYNTAX = { phrases: true, negation: true } as const;

/** `true` when the body is the countdown interstitial rather than a SERP. */
function isInterstitial(html: string): boolean {
	return html.includes("Wait For A Moment") || /\bid="countdown"/.test(html);
}

/** Lift the `sst` anti-bot token from the interstitial body. */
export function parseSstToken(html: string): string | undefined {
	return /[?&]sst=([A-Za-z0-9_-]+)/.exec(html)?.[1];
}

/** Publication date rendered inside the description ("Posted on 2026-09-04"). */
function extractPostedDate(text: string): string | undefined {
	return /\b(?:Posted|Published)\s+on\s+(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1];
}

/**
 * Walk the SERP in document order.
 *
 * Each organic hit is `<section class="card search-result">` containing
 * `<h2><a class="title" href>` for the target and `<p class="description">` for
 * the excerpt. `data-ms-rank` is present but its numbering is not trustworthy
 * as an index, so order is taken from the document itself.
 */
export function parseMarginaliaHtml(html: string, limit: number): SearchSource[] {
	const raw: Partial<SearchSource>[] = [];
	const blocks = html.split(/<section\b[^>]*\bclass="[^"]*\bsearch-result\b[^"]*"/i).slice(1);
	for (const block of blocks) {
		const anchor = /<a\b[^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		const url = decodeHtmlText(anchor[1]);
		if (!/^https?:\/\//i.test(url)) continue;
		const title = decodeHtmlText(anchor[2]);
		if (!title) continue;

		const descriptionHtml = /<p\b[^>]*\bclass="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1];
		const description = descriptionHtml ? decodeHtmlText(descriptionHtml) : undefined;
		const publishedDate = description ? extractPostedDate(description) : undefined;

		raw.push({
			title,
			url,
			...(description ? { snippet: clipSnippet(description) } : {}),
			...(publishedDate ? { publishedDate } : {}),
		});
		if (raw.length >= limit) break;
	}
	return toSearchSources(raw, limit);
}

/** One host's request, including the `sst` token replay. */
async function fetchFromHost(
	host: string,
	query: string,
	params: SearchParams,
	signal: AbortSignal,
): Promise<{ html: string; status: number } | undefined> {
	const build = (sst?: string): string => {
		const url = new URL("/search", host);
		url.searchParams.set("query", query);
		if (sst) url.searchParams.set("sst", sst);
		return url.toString();
	};
	const get = async (target: string): Promise<Response> =>
		params.fetchImpl(target, { method: "GET", headers: BROWSER_HEADERS, signal, redirect: "follow" });

	const first = await get(build());
	if (!first.ok) return undefined;
	const firstHtml = await readBodyCapped(first);
	if (!isInterstitial(firstHtml)) return { html: firstHtml, status: first.status };

	const token = parseSstToken(firstHtml);
	if (!token) return { html: firstHtml, status: first.status };

	const second = await get(build(token));
	if (!second.ok) return undefined;
	return { html: await readBodyCapped(second), status: second.status };
}

export async function searchMarginalia(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const query = params.parsedQuery.hasDirectives
		? formatScraperQuery(params.parsedQuery, MARGINALIA_QUERY_SYNTAX)
		: params.query;

	let lastError: unknown;
	for (const host of SEARCH_HOSTS) {
		try {
			const page = await fetchFromHost(host, query, params, signal);
			if (!page) continue;
			if (isInterstitial(page.html) && !parseSstToken(page.html)) {
				lastError = new SearchProviderError(
					"marginalia",
					"Marginalia served its anti-bot interstitial without a token.",
					429,
				);
				continue;
			}
			const sources = parseMarginaliaHtml(page.html, limit);
			if (sources.length > 0) return { provider: "marginalia", sources, authMode: "keyless" };
			lastError = new SearchProviderError(
				"marginalia",
				"Marginalia returned no results (its index is small; this is expected for mainstream queries).",
				204,
			);
		} catch (error) {
			if (params.signal?.aborted) throw error;
			lastError = error;
		}
	}

	throw lastError instanceof Error
		? lastError
		: new SearchProviderError("marginalia", "Marginalia returned no results.", 204);
}

export class MarginaliaProvider implements SearchProvider {
	readonly id = "marginalia";
	readonly label = "Marginalia";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchMarginalia(params);
	}
}

/** Convenience for one-off callers and the probe harness. */
export function searchMarginaliaRaw(query: string, limit = DEFAULT_NUM_RESULTS): ReturnType<typeof searchMarginalia> {
	return searchMarginalia({
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
