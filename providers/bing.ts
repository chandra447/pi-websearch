/**
 * Bing — the HTML SERP, no API key.
 *
 * The one mainstream engine that still serves complete, un-styled organic
 * results to a plain `fetch()` from most networks. Verified from a shared/VPN
 * egress IP where DuckDuckGo, Startpage, Mojeek and Ecosia all wall: Bing
 * answered HTTP 200 with ten `.b_algo` blocks.
 *
 * Two things make this parse rather than pretend:
 *  - every organic href is wrapped as `https://www.bing.com/ck/a?…&u=a1<blob>`,
 *    so a naive `href` grab yields bing.com for every result. The `u=` payload
 *    is base64url with a leading `a1` marker and no padding.
 *  - Bing renders its own telemetry `<link>`/`<style>` noise *inside* each
 *    `<li class="b_algo">`, so the block must be scanned for the `<h2>` anchor
 *    rather than assumed to start with it.
 *
 * Bing answers its bot wall with HTTP 200 as well, so the challenge check is on
 * the body, not the status.
 */

import { parseSearchQuery } from "../query.ts";
import { formatScraperQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { BROWSER_HEADERS, decodeHtmlText, readBodyCapped } from "./html.ts";
import { clampNumResults, clipSnippet, isChallengeBody, toSearchSources, withHardTimeout } from "./utils.ts";

const SEARCH_URL = "https://www.bing.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
/** Bing pages by 10 regardless of `count`; three pages is plenty before a wall. */
const RESULTS_PER_PAGE = 10;
const MAX_PAGES = 3;

/**
 * Bing parses the human operator set. `intext:` and absolute dates are not
 * reliable there, so they stay out of the query and are enforced by the
 * orchestrator's lenient post-filter instead.
 */
const BING_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	filetype: true,
	inTitle: true,
	inUrl: true,
} as const;

/**
 * Bing's `filters=ex1:"ezN"` freshness tokens. Only the three that are
 * documented are mapped; `year` is dropped rather than guessed, because a wrong
 * token silently narrows the index to nothing.
 */
const RECENCY_TO_BING_FILTER: Record<string, string> = {
	day: 'ex1:"ez1"',
	week: 'ex1:"ez2"',
	month: 'ex1:"ez3"',
};

/**
 * Resolve a `bing.com/ck/a` click redirect back to its target.
 *
 * The payload is `a1` followed by unpadded base64url. Anything that does not
 * match that shape is returned as-is when it is already absolute.
 */
export function unwrapBingUrl(href: string): string | undefined {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	const blob = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(decoded)?.[1];
	if (blob) {
		const base64 = blob.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		try {
			const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
			const target = new TextDecoder().decode(bytes);
			if (/^https?:\/\//i.test(target)) return target;
		} catch {
			// fall through to the non-redirect shapes below
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (/^https?:\/\//i.test(decoded)) return decoded;
	return undefined;
}

/** Split a SERP into per-result blocks on the `b_algo` list-item marker. */
function splitResultBlocks(html: string): string[] {
	return html.split(/<li class="b_algo"/).slice(1);
}

/** Lift title, href and snippet out of one `b_algo` block. */
export function parseBingBlocks(html: string, limit: number): SearchSource[] {
	const raw: Partial<SearchSource>[] = [];
	for (const block of splitResultBlocks(html)) {
		// The anchor lives inside <h2>; anything before it is <link>/<style> noise.
		const headingStart = block.indexOf("<h2");
		if (headingStart < 0) continue;
		const heading = block.slice(headingStart);
		const anchor = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(heading);
		if (!anchor) continue;
		const url = unwrapBingUrl(anchor[1]);
		if (!url) continue;
		const title = decodeHtmlText(anchor[2]);
		if (!title) continue;

		// Snippet is the first paragraph in the caption block; `b_lineclamp*`
		// variants change between renders, so match the class prefix.
		const snippetMatch =
			/<p\b[^>]*class="[^"]*\bb_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(heading) ??
			/<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(heading);

		raw.push({
			title,
			url,
			...(snippetMatch ? { snippet: clipSnippet(decodeHtmlText(snippetMatch[1])) } : {}),
		});
		if (raw.length >= limit) break;
	}
	return toSearchSources(raw, limit);
}

/** Build the SERP URL for one page of results. */
export function buildBingUrl(params: SearchParams, first: number, count: number): string {
	const parsed = params.parsedQuery;
	const query = parsed.hasDirectives
		? formatScraperQuery(parsed, BING_QUERY_SYNTAX)
		: params.query;
	const url = new URL(SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	url.searchParams.set("setlang", "en");
	if (first > 1) url.searchParams.set("first", String(first));
	const filter = params.recency ? RECENCY_TO_BING_FILTER[params.recency] : undefined;
	if (filter) url.searchParams.set("filters", filter);
	return url.toString();
}

export async function searchBing(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();

	for (let page = 0; page < MAX_PAGES && sources.length < limit; page++) {
		const first = page * RESULTS_PER_PAGE + 1;
		const response = await params.fetchImpl(buildBingUrl(params, first, RESULTS_PER_PAGE), {
			method: "GET",
			headers: BROWSER_HEADERS,
			signal,
			redirect: "follow",
		});
		const html = await readBodyCapped(response);

		if (!response.ok) {
			// Bing serves its wall at 200; a non-2xx here is a real transport error.
			throw new SearchProviderError(
				"bing",
				`Bing returned HTTP ${response.status}.`,
				response.status,
			);
		}
		if (isChallengeBody(html)) {
			throw new SearchProviderError(
				"bing",
				"Bing blocked the request with a bot-detection challenge.",
				429,
			);
		}

		const before = sources.length;
		for (const source of parseBingBlocks(html, limit)) {
			if (seen.has(source.url)) continue;
			seen.add(source.url);
			sources.push(source);
			if (sources.length >= limit) break;
		}
		// A page that adds nothing means Bing has no more results (or rotated to
		// a layout this parser does not read); stop instead of re-requesting.
		if (sources.length === before) break;
	}

	if (sources.length === 0) {
		throw new SearchProviderError("bing", "Bing returned no parseable results.", 204);
	}

	return { provider: "bing", sources: sources.slice(0, limit), authMode: "keyless" };
}

export class BingProvider implements SearchProvider {
	readonly id = "bing";
	readonly label = "Bing";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBing(params);
	}
}

/** Convenience for one-off callers and the probe harness. */
export function searchBingRaw(query: string, limit = DEFAULT_NUM_RESULTS): ReturnType<typeof searchBing> {
	const parsedQuery = parseSearchQuery(query);
	return searchBing({
		query,
		parsedQuery,
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
