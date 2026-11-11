/**
 * Startpage — a privacy frontend over Google's index. No API key.
 *
 * Startpage serves fully server-rendered results, so no JavaScript engine is
 * needed. Its bot defence keys on requests that skip the homepage handshake:
 * the search form carries a session token (`sc`) plus sibling hidden inputs,
 * and posting the form with a stale or absent token redirects to the CAPTCHA
 * shell. The documented flow is therefore the same dance a browser performs —
 * GET the homepage, lift the form's hidden inputs, POST them back with the
 * query — and degrades to a tokenless GET when the form cannot be read.
 *
 * Challenge detection deliberately does not grep for the bare word "captcha":
 * a search *about* captchas would then self-destruct. It matches the error-page
 * component markers and the token wall instead.
 */

import { formatScraperQuery, parseSearchQuery } from "../query.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import type { SearchParams, SearchProvider } from "./base.ts";
import { BROWSER_HEADERS, decodeHtmlText, readBodyCapped } from "./html.ts";
import { clampNumResults, clipSnippet, toSearchSources, withHardTimeout } from "./utils.ts";

const HOME_URL = "https://www.startpage.com/";
const SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** Startpage proxies Google, so the operator set passes through inline. */
const STARTPAGE_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	filetype: true,
	inTitle: true,
	inUrl: true,
} as const;

/** `with_date` accepts single letters; an absent value is the unfiltered default. */
const RECENCY_TO_WITH_DATE: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

/** `true` when Startpage answered with its CAPTCHA/error shell instead of results. */
function isChallengePage(html: string): boolean {
	return (
		html.includes("component---src-pages-captcha") ||
		html.includes("/sp/captcha") ||
		html.includes('id="captcha"') ||
		html.includes("unusual traffic")
	);
}

/**
 * Lift the hidden inputs from the homepage's `/sp/search` form.
 * Returns `undefined` when the form or its `sc` token is missing.
 */
export function parseSearchFormInputs(html: string): Record<string, string> | undefined {
	const form = /<form\b[^>]*action="\/sp\/search"[^>]*>([\s\S]*?)<\/form>/i.exec(html)?.[1];
	if (!form) return undefined;
	const inputs: Record<string, string> = {};
	for (const tag of form.match(/<input\b[^>]*>/gi) ?? []) {
		if (!/\btype="hidden"/i.test(tag)) continue;
		const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
		const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? "";
		if (name) inputs[name] = decodeHtmlText(value);
	}
	return inputs.sc ? inputs : undefined;
}

/** Accept only http(s) targets that point away from Startpage itself. */
function sanitizeResultUrl(href: string): string | undefined {
	try {
		const url = new URL(decodeHtmlText(href), HOME_URL);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

/**
 * Walk the server-rendered results page in document order.
 *
 * Each organic hit is a `div.result` container holding `a.result-link` (with an
 * `h2`/`h3` heading) and an optional `p.description`. Startpage does not wrap
 * outbound clicks, so the href is the target. The offscreen adblock honeypot
 * uses the class token `a-bg-result`, which the split below cannot match.
 */
export function parseStartpageHtml(html: string, limit: number): SearchSource[] {
	const raw: Partial<SearchSource>[] = [];
	for (const block of html.split(/<div class="result\b/).slice(1)) {
		const anchors = block.match(/<a\b[^>]*>/gi) ?? [];
		const linkTag = anchors.find(tag => /\bclass="[^"]*\bresult-link\b/i.test(tag));
		if (!linkTag) continue;
		const href = /\bhref="([^"]*)"/i.exec(linkTag)?.[1];
		if (!href) continue;
		const url = sanitizeResultUrl(href);
		if (!url) continue;

		const anchorBody = /<a\b[^>]*\bclass="[^"]*\bresult-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "";
		const title =
			decodeHtmlText(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(anchorBody)?.[1] ?? "") ||
			decodeHtmlText(anchorBody);
		if (!title) continue;

		const snippet = /<p\b[^>]*\bclass="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1];

		raw.push({
			title,
			url,
			...(snippet ? { snippet: clipSnippet(decodeHtmlText(snippet)) } : {}),
		});
		if (raw.length >= limit) break;
	}
	return toSearchSources(raw, limit);
}

/** Fetch the homepage and lift the search form's hidden inputs. Best effort. */
async function fetchFormInputs(params: SearchParams, signal: AbortSignal): Promise<Record<string, string> | undefined> {
	try {
		const response = await params.fetchImpl(HOME_URL, {
			method: "GET",
			headers: BROWSER_HEADERS,
			signal,
			redirect: "follow",
		});
		if (!response.ok) return undefined;
		const html = await readBodyCapped(response);
		if (isChallengePage(html)) return undefined;
		return parseSearchFormInputs(html);
	} catch (error) {
		// A homepage failure is not fatal: the tokenless GET below may still work.
		if (params.signal?.aborted) throw error;
		return undefined;
	}
}

export async function searchStartpage(params: SearchParams): Promise<SearchResponse> {
	const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const query = params.parsedQuery.hasDirectives
		? formatScraperQuery(params.parsedQuery, STARTPAGE_QUERY_SYNTAX)
		: params.query;
	const withDate = params.recency ? RECENCY_TO_WITH_DATE[params.recency] : undefined;

	const formInputs = await fetchFormInputs(params, signal);
	let response: Response;
	if (formInputs) {
		const form = new URLSearchParams(formInputs);
		form.set("query", query);
		if (withDate) form.set("with_date", withDate);
		response = await params.fetchImpl(SEARCH_URL, {
			method: "POST",
			headers: {
				...BROWSER_HEADERS,
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: HOME_URL,
			},
			body: form.toString(),
			signal,
			redirect: "follow",
		});
	} else {
		const url = new URL(SEARCH_URL);
		url.searchParams.set("query", query);
		if (withDate) url.searchParams.set("with_date", withDate);
		response = await params.fetchImpl(url.toString(), {
			method: "GET",
			headers: { ...BROWSER_HEADERS, Referer: HOME_URL },
			signal,
			redirect: "follow",
		});
	}

	const html = await readBodyCapped(response);
	if (isChallengePage(html)) {
		throw new SearchProviderError(
			"startpage",
			"Startpage blocked the request with a CAPTCHA challenge (it rate-limits automated searches from datacenter and shared-egress IPs).",
			429,
		);
	}
	if (!response.ok) {
		throw new SearchProviderError("startpage", `Startpage returned HTTP ${response.status}.`, response.status);
	}

	const sources = parseStartpageHtml(html, limit);
	if (sources.length === 0) {
		throw new SearchProviderError("startpage", "Startpage returned no parseable results.", 204);
	}

	return { provider: "startpage", sources, authMode: "keyless" };
}

export class StartpageProvider implements SearchProvider {
	readonly id = "startpage";
	readonly label = "Startpage";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params);
	}
}

/** Convenience for one-off callers and the probe harness. */
export function searchStartpageRaw(query: string, limit = DEFAULT_NUM_RESULTS): ReturnType<typeof searchStartpage> {
	return searchStartpage({
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
