/**
 * Shared value types for the web_search tool.
 *
 * These mirror oh-my-pi's `web/search/types.ts` closely enough that a provider
 * written for one ports to the other with only an import change. `answer` and
 * `citations` are unused by every provider shipped here — Pi extensions cannot
 * reach a grounded chat model — but they stay in the shape so a grounded
 * backend can be added later without reformatting anything.
 */

export type Recency = "day" | "week" | "month" | "year";

/** One search hit. `snippet` is always pre-truncated by the provider. */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO-8601 date as the upstream reported it, when it reported one. */
	publishedDate?: string;
	/** `publishedDate` resolved to "how long ago", for stable display ordering. */
	ageSeconds?: number;
}

export interface SearchCitation {
	title?: string;
	url: string;
	citedText?: string;
}

export interface SearchResponse {
	provider: string;
	sources: SearchSource[];
	answer?: string;
	citations?: SearchCitation[];
	relatedQuestions?: string[];
	searchQueries?: string[];
	requestId?: string;
	authMode?: "api_key" | "keyless" | "oauth" | "public";
}

/** One failed candidate as the transcript records it. */
export interface SearchFailureDetail {
	provider: string;
	label: string;
	reason: string;
	status?: number;
}

/** Value stored on the tool result; rendered by `renderResult`. */
export interface SearchResultDetails {
	response: SearchResponse;
	error?: string;
	failures?: SearchFailureDetail[];
	/** Milliseconds per attempted provider, in attempt order. Absent on mocks. */
	timings?: { provider: string; ms: number; ok: boolean }[];
}

/**
 * A provider failure carrying the upstream status so the orchestrator can tell
 * "walled" (429/403 → advance) from "cancelled" (AbortError → rethrow) and so
 * `details.failures[].status` is meaningful.
 *
 * `204` is reserved for "answered successfully but returned nothing usable" —
 * the orchestrator's sentinel for a backend that silently produced no sources.
 */
export class SearchProviderError extends Error {
	readonly provider: string;
	readonly status: number | undefined;

	constructor(provider: string, message: string, status?: number) {
		super(message);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.status = status;
	}
}

/** Longest snippet rendered per source. Matches omp's cap. */
export const SNIPPET_CHARS = 240;

/** Longest failure reason quoted in the fallback note. Provider errors can carry whole response bodies. */
export const MAX_FALLBACK_REASON_CHARS = 240;

/**
 * Provider ids. Kept as a plain union of string literals rather than an enum:
 * Pi loads extensions through jiti, but `test/probe.ts` runs under bare node
 * type-stripping, where `enum` is not erasable syntax.
 */
export type SearchProviderId =
	| "parallel"
	| "exa"
	| "keenable"
	| "bing"
	| "firecrawl"
	| "duckduckgo"
	| "brave"
	| "tavily"
	| "startpage"
	| "bravehtml"
	| "searxng"
	| "kagi"
	| "jina"
	| "deepseek"
	| "marginalia"
	| "public";

/** Display labels. Single source of truth for the transcript and failure notes. */
export const SEARCH_PROVIDER_LABELS: Record<SearchProviderId, string> = {
	parallel: "Parallel",
	exa: "Exa",
	keenable: "Keenable",
	bing: "Bing",
	firecrawl: "Firecrawl",
	duckduckgo: "DuckDuckGo",
	brave: "Brave",
	tavily: "Tavily",
	startpage: "Startpage",
	bravehtml: "Brave (HTML)",
	searxng: "SearXNG",
	kagi: "Kagi",
	jina: "Jina",
	deepseek: "DeepSeek",
	marginalia: "Marginalia",
	public: "Public Web",
};

export function providerLabel(id: string): string {
	return (SEARCH_PROVIDER_LABELS as Record<string, string>)[id] ?? id;
}
