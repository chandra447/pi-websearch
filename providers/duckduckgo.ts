/**
 * DuckDuckGo — the no-JS HTML frontend, no API key.
 *
 * Works from residential IPs; from datacenter/VPN egress DuckDuckGo answers
 * HTTP 202 with an `anomaly-modal` bot wall (verified from the machine this was
 * built on). It therefore sits *after* the JSON services in the default chain:
 * useful depth, never a dependency.
 *
 * Two details are what make this parse rather than pretend:
 *  - outbound links are wrapped as `//duckduckgo.com/l/?uddg=<encoded>`, so a
 *    naive `href` grab yields duckduckgo.com for every result;
 *  - a walled response is HTTP 200/202 with a challenge *body*, so a status
 *    check alone reports "0 results" forever instead of failing over.
 *
 * The Instant Answer API is deliberately not used: it only answers
 * Wikipedia/Wolfram-style topics and returns nothing for ordinary queries.
 */

import { formatScraperQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { clampNumResults, clipSnippet, dateToAgeSeconds, isChallengeBody, toSearchSources, withHardTimeout } from "./utils.ts";

const HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** DDG's time filter form parameter. Values outside this set are ignored upstream. */
const RECENCY_TO_DF: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

/** The HTML frontend understands the human operator set but not absolute dates. */
const DDG_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	inUrl: true,
	inTitle: true,
	inText: true,
	filetype: true,
} as const;

/** Decode a fragment lifted from DDG markup: strip inline tags, unescape, normalize. */
function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a result href back to the real target.
 *
 * Handles the three shapes the page mixes in practice: `uddg=` redirect
 * wrappers, protocol-relative links, and absolute URLs. Advertising click
 * redirects (`y.js`) are discarded rather than returned as a result.
 */
export function unwrapResultUrl(href: string): string | undefined {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	if (/^(?:https?:)?\/\/(?:www\.)?duckduckgo\.com\/y\.js(?:[?#]|$)/i.test(decoded)) return undefined;
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	if (wrapped) {
		try {
			return decodeURIComponent(wrapped[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (/^https?:\/\//i.test(decoded)) return decoded;
	return undefined;
}

/** Lift a publication date, scanning only the URL-extras container so a date-shaped snippet is not misread. */
function extractPublishedDate(block: string): string | undefined {
	const extras = /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
	if (!extras) return undefined;
	for (const match of extras.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
		const text = decodeHtmlText(match[1]);
		if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
	}
	return undefined;
}

/**
 * Pull result blocks out in document order. Snippets and dates are optional;
 * the pagination row is tolerated and simply never matches the title regex.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchSource[] {
	const sources: Partial<SearchSource>[] = [];
	const blockPattern =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titlePattern = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetPattern = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;

	for (const match of html.matchAll(blockPattern)) {
		const block = match[1];
		const titleMatch = titlePattern.exec(block);
		if (!titleMatch) continue;
		const url = unwrapResultUrl(titleMatch[1]);
		if (!url) continue;
		const title = decodeHtmlText(titleMatch[2]);
		if (!title) continue;
		const snippet = snippetPattern.exec(block);
		const publishedDate = extractPublishedDate(block);
		sources.push({
			title,
			url,
			snippet: clipSnippet(snippet ? decodeHtmlText(snippet[1]) : undefined),
			...(publishedDate ? { publishedDate } : {}),
			...(publishedDate ? { ageSeconds: dateToAgeSeconds(publishedDate) } : {}),
		});
		if (sources.length >= limit) break;
	}

	return toSearchSources(sources, limit);
}

/** Hidden fields of DDG's next-page form, for the second page only. */
function parseContinuationForm(html: string): string | undefined {
	for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
		const params = new URLSearchParams();
		for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
			const input = inputMatch[0];
			const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			if (name && value !== undefined) params.append(decodeHtmlText(name), decodeHtmlText(value));
		}
		if (params.has("s") && params.has("vqd")) return params.toString();
	}
	return undefined;
}

export const duckDuckGoProvider: SearchProvider = {
	id: "duckduckgo",
	label: "DuckDuckGo",
	isAvailable: () => true,

	async search(params: SearchParams): Promise<SearchResponse> {
		const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
		const parsed = params.parsedQuery;
		const signal = withHardTimeout(params.signal, params.timeoutMs);

		let form: string | undefined = new URLSearchParams({
			q: formatScraperQuery(parsed, DDG_QUERY_SYNTAX),
			kl: "us-en",
			...(params.recency && RECENCY_TO_DF[params.recency] ? { df: RECENCY_TO_DF[params.recency] } : {}),
			b: "",
		}).toString();

		const sources: SearchSource[] = [];
		const seen = new Set<string>();
		let pages = 0;

		while (form && sources.length < limit && pages < 2) {
			pages++;
			const response = await params.fetchImpl(HTML_URL, {
				method: "POST",
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Content-Type": "application/x-www-form-urlencoded",
					"Accept-Language": "en-US,en;q=0.9",
					Referer: "https://html.duckduckgo.com/",
				},
				body: form,
				signal,
			});

			const html = await response.text();
			if (!response.ok) {
				throw new SearchProviderError(
					"duckduckgo",
					`DuckDuckGo HTML error (${response.status}).`,
					response.status,
				);
			}
			if (isChallengeBody(html)) {
				throw new SearchProviderError(
					"duckduckgo",
					"DuckDuckGo blocked the request with a bot-detection challenge (its HTML frontend throttles datacenter and shared egress IPs). A credentialed provider such as Brave, Tavily, Exa, or Kagi is more reliable from this network.",
					429,
				);
			}

			const before = sources.length;
			for (const source of parseDuckDuckGoHtml(html, limit)) {
				if (seen.has(source.url)) continue;
				seen.add(source.url);
				sources.push(source);
				if (sources.length >= limit) break;
			}
			if (sources.length === before) break;
			form = parseContinuationForm(html);
		}

		if (sources.length === 0) {
			throw new SearchProviderError("duckduckgo", "DuckDuckGo returned no results.", 204);
		}
		return { provider: "duckduckgo", sources, authMode: "keyless" };
	},
};

/**
 * Class-shaped view of {@link duckDuckGoProvider}.
 *
 * `registry.ts` instantiates providers (`new ExaProvider()`), while this module
 * builds the provider as a plain object. Exporting both keeps the object as the
 * single implementation and satisfies either calling convention, instead of
 * duplicating the parser.
 */
export class DuckDuckGoProvider implements SearchProvider {
	readonly id = duckDuckGoProvider.id;
	readonly label = duckDuckGoProvider.label;

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return duckDuckGoProvider.search(params);
	}
}
