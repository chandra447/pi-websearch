/**
 * `public`: credential-free aggregate meta-provider.
 *
 * Fans out to every keyless HTML engine concurrently, dedupes URLs across
 * engines on a canonical key, and ranks by cross-engine consensus. Ported from
 * oh-my-pi's `providers/public.ts`.
 *
 * Three exits race and the earliest wins: every engine settled; the soft
 * deadline elapsed with at least one success in hand; the hard cap elapsed
 * regardless. Stragglers are aborted once the race resolves. Individual engine
 * failures (bot challenges, timeouts) are tolerated; the call fails only when
 * every engine fails.
 *
 * Explicit-only, like omp: fanning out to five engines multiplies request
 * volume by five, so it must be a deliberate `provider: "public"` choice rather
 * than an implicit step in the automatic chain.
 */

import type { SearchParams, SearchProvider } from "./base.ts";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types.ts";
import { clampNumResults, withHardTimeout } from "./utils.ts";
import { looksRelevant } from "../query.ts";
import { BingProvider } from "./bing.ts";
import { BraveHtmlProvider } from "./bravehtml.ts";
import { duckDuckGoProvider } from "./duckduckgo.ts";
import { MarginaliaProvider } from "./marginalia.ts";
import { StartpageProvider } from "./startpage.ts";

/**
 * Order is the tiebreak for merged ranking (earlier engines win equal
 * consensus/rank), so engines with the best ranking quality come first.
 */
const PUBLIC_ENGINES: readonly SearchProvider[] = [
	new BingProvider(),
	duckDuckGoProvider,
	new StartpageProvider(),
	new BraveHtmlProvider(),
	new MarginaliaProvider(),
];

/** Aggregates get a wider window than single engines: consensus needs breadth. */
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/** Past this point the aggregate returns as soon as it has one engine's results. */
const SOFT_DEADLINE_MS = 5_000;

/** The aggregate returns whatever it has, even nothing, so one slow engine cannot pin the call. */
const HARD_DEADLINE_MS = 30_000;

export interface PublicWebDeadlines {
	softMs?: number;
	hardMs?: number;
}

interface MergedSource {
	source: SearchSource;
	/** Number of engines that returned this URL — the primary ranking signal. */
	engines: number;
	/** Best (lowest) per-engine rank observed. */
	bestRank: number;
	/** First-seen insertion index; the final tiebreak keeps ordering deterministic. */
	order: number;
}

/**
 * Canonical dedup key: host without a leading `www.`, path without a trailing
 * slash, query preserved, fragment dropped. Engines disagree on exactly these
 * variations for the same page.
 */
function dedupKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		let path = url.pathname;
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
	for (const [rank, source] of sources.entries()) {
		const key = dedupKey(source.url);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
			continue;
		}
		existing.engines += 1;
		if (rank < existing.bestRank) {
			existing.bestRank = rank;
			existing.source.title = source.title;
			existing.source.url = source.url;
		}
		// Keep the most informative snippet regardless of which engine ranked it best.
		if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
			existing.source.snippet = source.snippet;
		}
		existing.source.publishedDate ??= source.publishedDate;
		existing.source.ageSeconds ??= source.ageSeconds;
	}
}

export async function searchPublicWeb(
	params: SearchParams,
	deadlines: PublicWebDeadlines = {},
): Promise<SearchResponse> {
	const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
	const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
	// `SearchParams` has no separate breadth field: the orchestrator already
	// collapsed `num_search_results ?? limit` into `limit`.
	const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const straggler = new AbortController();
	const signal = AbortSignal.any([withHardTimeout(params.signal, params.timeoutMs), straggler.signal]);

	const responses: (SearchResponse | undefined)[] = new Array(PUBLIC_ENGINES.length);
	const failures: { label: string; error: unknown }[] = [];
	const firstSuccess = Promise.withResolvers<void>();

	const all = Promise.all(
		PUBLIC_ENGINES.map(async (provider, position) => {
			try {
				const response = await provider.search({ ...params, signal });
				// Filter per engine, before merging. A poisoned engine must not reach
				// the consensus index at all: the orchestrator's check runs once on the
				// merged top-5, so one good engine answering would let a walled engine's
				// unrelated results ride along with it.
				if (response.sources.length > 0 && !looksRelevant(params.parsedQuery, response.sources)) {
					throw new SearchProviderError(
						provider.id,
						`${provider.label} returned results unrelated to the query; ignoring them.`,
						204,
					);
				}
				responses[position] = response;
				firstSuccess.resolve();
			} catch (error) {
				failures.push({ label: provider.label, error });
			}
		}),
	);

	await Promise.race([all, new Promise(resolve => setTimeout(resolve, softMs))]);
	if (!responses.some(response => response !== undefined) && failures.length < PUBLIC_ENGINES.length) {
		await Promise.race([
			all,
			firstSuccess.promise,
			new Promise(resolve => setTimeout(resolve, Math.max(0, hardMs - softMs))),
		]);
	}
	straggler.abort();

	// Merge in engine-priority order (not settlement order) so tiebreaks stay deterministic.
	const merged = new Map<string, MergedSource>();
	for (const response of responses) {
		if (response) mergeSources(merged, response.sources);
	}

	if (merged.size === 0) {
		const detail = failures
			.map(failure => `${failure.label}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)
			.join("; ");
		throw new SearchProviderError(
			"public",
			detail ? `All public engines failed: ${detail}` : "All public engines returned no results",
			503,
		);
	}

	const sources = [...merged.values()]
		.sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
		.slice(0, numResults)
		.map(entry => entry.source);

	return { provider: "public", sources, authMode: "public" };
}

/**
 * Aggregate over every credential-free engine. Unavailable in the automatic
 * chain, available when named: `provider: "public"`.
 */
export class PublicWebProvider implements SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(): boolean {
		return false;
	}

	isExplicitlyAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
