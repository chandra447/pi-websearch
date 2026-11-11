/**
 * The web search orchestrator, deliberately free of Pi imports so it can be
 * exercised directly under `bun`/`node` without booting the agent.
 *
 * This module is the port of oh-my-pi's fallback-chain search tool.
 *
 * Why a chain: no single search provider is reliable. HTML scrapers get bot
 * walls, free API tiers rate limit, keyed APIs expire. So each request walks an
 * ordered list of providers sequentially and returns the first acceptable
 * answer, naming the failures that preceded it. Providers with an
 * unauthenticated path (Exa's public MCP, Keenable's public endpoint, Bing and
 * DuckDuckGo's HTML frontends, Parallel's and Firecrawl's keyless modes) mean
 * search works with zero configuration.
 *
 * Ported semantics from oh-my-pi `packages/coding-agent/src/web/search/index.ts`:
 *   - sequential fallback with a per-provider hard timeout
 *   - availability gating (unavailable candidates are skipped silently)
 *   - a response with no renderable content is a failure, not a success
 *   - lenient constraint post-filtering that RELAXES a directive rather than
 *     returning nothing, and says so
 *   - cancellation is rethrown, never recorded as a provider failure
 *   - a leading `Note:` names which provider answered and why the others failed
 *   - the all-failed case is a normal tool result with per-failure details
 */

import {
	CONFIG_PATH,
	DEFAULT_LIMIT,
	DEFAULT_MAX_LIMIT,
	loadConfig,
	loadCredentials,
	type Credentials,
	type WebSearchConfig,
} from "./config.ts";
import { applyQueryConstraints, looksRelevant, parseSearchQuery } from "./query.ts";
import { explicitlyAvailable, type SearchProvider } from "./providers/base.ts";
import { getProvider, isProviderId, providerIds } from "./providers/registry.ts";
import {
	MAX_FALLBACK_REASON_CHARS,
	providerLabel,
	SearchProviderError,
	SNIPPET_CHARS,
	type SearchFailureDetail,
	type SearchResponse,
	type SearchResultDetails,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

interface ChainEntry {
	provider: SearchProvider;
	explicit: boolean;
}

/**
 * Build the ordered candidate list.
 *
 * - An explicit `provider` collapses the chain to that single candidate and
 *   marks it explicit, so its keyless fallback path is allowed to run.
 * - Otherwise the configured (or built-in default) order wins, followed by any
 *   registered provider the list omitted — so a user who just exports
 *   `KAGI_API_KEY` gets Kagi without editing config.
 * - `public` is never appended implicitly: fanning out to every keyless engine
 *   multiplies request volume, so it stays a deliberate choice (same rule as
 *   oh-my-pi).
 */
function resolveChain(config: WebSearchConfig, explicitProvider?: string): ChainEntry[] {
	if (explicitProvider) {
		if (!isProviderId(explicitProvider)) {
			throw new Error(
				`Unknown web search provider "${explicitProvider}". Known providers: ${providerIds().join(", ")}.`,
			);
		}
		if (config.disabled.includes(explicitProvider)) {
			throw new Error(`Provider "${explicitProvider}" is disabled in ${CONFIG_PATH}.`);
		}
		return [{ provider: getProvider(explicitProvider)!, explicit: true }];
	}

	// Honor the configured chain exactly. Silently appending providers the user
	// left out would make the config a lie and turn `PI_WEBSEARCH_CHAIN=bing`
	// into "bing first, then everything anyway".
	const chain: ChainEntry[] = [];
	for (const id of config.chain) {
		if (config.disabled.includes(id)) continue;
		const provider = getProvider(id);
		if (provider) chain.push({ provider, explicit: false });
	}
	return chain;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Flatten a provider error into the one-line reason a fallback note quotes. */
function formatProviderFailure(error: unknown, provider: { id: string; label: string }): string {
	if (error instanceof SearchProviderError) {
		// The classified message already distinguishes "your key is wrong" from
		// "this network is blocked". Rewriting it here into a generic auth failure
		// is how a VPN/IP block came to read "Check the API key or base URL".
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

function failureDetails(
	failures: readonly { provider: { id: string; label: string }; error: unknown }[],
): SearchFailureDetail[] {
	return failures.map(({ provider, error }): SearchFailureDetail => {
		const reason = formatProviderFailure(error, provider).replace(/\s+/g, " ").trim().replace(/\.$/, "");
		return {
			provider: provider.id,
			label: provider.label,
			reason: reason.length > MAX_FALLBACK_REASON_CHARS ? `${reason.slice(0, MAX_FALLBACK_REASON_CHARS)}…` : reason,
			...(error instanceof SearchProviderError && error.status !== undefined ? { status: error.status } : {}),
		};
	});
}

/** Note naming the candidates that failed before `served` answered. */
function fallbackNotes(failed: readonly SearchFailureDetail[], served: { label: string }): string[] {
	if (failed.length === 0) return [];
	return [`answered by ${served.label} after ${failed.map(f => `${f.label} failed (${f.reason})`).join(" and ")}`];
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Render a human-readable age from `ageSeconds` or a reported date. */
function formatAge(source: { ageSeconds?: number; publishedDate?: string }): string | undefined {
	if (typeof source.ageSeconds === "number" && Number.isFinite(source.ageSeconds)) {
		const s = Math.max(0, source.ageSeconds);
		if (s < 3_600) return `${Math.max(1, Math.round(s / 60))}m ago`;
		if (s < 86_400) return `${Math.round(s / 3_600)}h ago`;
		if (s < 2_592_000) return `${Math.round(s / 86_400)}d ago`;
		if (s < 31_536_000) return `${Math.round(s / 2_592_000)}mo ago`;
		return `${Math.round(s / 31_536_000)}y ago`;
	}
	return source.publishedDate;
}

/** Format a response for LLM consumption. `notes` lead the output. */
export function formatForLLM(
	response: SearchResponse,
	notes: readonly string[] = [],
	header?: string,
): string {
	const parts: string[] = [];
	for (const note of notes) parts.push(`Note: ${note}`);
	if (header) parts.push(header);

	if (response.answer) parts.push(response.answer);

	if (response.sources.length > 0) parts.push(`\n## Sources (${response.sources.length})`);

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src);
		parts.push(`[${i + 1}] ${src.title}${age ? ` (${age})` : ""}\n    ${src.url}`);
		if (src.snippet) parts.push(`    ${truncate(src.snippet, SNIPPET_CHARS)}`);
	}

	if (response.citations && response.citations.length > 0) {
		parts.push(`\n## Citations (${response.citations.length})`);
		for (const [i, citation] of response.citations.entries()) {
			parts.push(`[${i + 1}] ${citation.title || citation.url}\n    ${citation.url}`);
			if (citation.citedText) parts.push(`    ${truncate(citation.citedText, SNIPPET_CHARS)}`);
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push(`\n## Related (${response.relatedQuestions.length})`);
		for (const question of response.relatedQuestions) parts.push(`- ${question}`);
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) parts.push(`- ${truncate(query, 120)}`);
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

// ---------------------------------------------------------------------------
// The fallback loop
// ---------------------------------------------------------------------------

export interface SearchOptions {
	query: string;
	limit?: number;
	recency?: "day" | "week" | "month" | "year";
	/** Pin one provider instead of walking the chain. */
	provider?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	/** Overrides for tests; production callers let the extension resolve them. */
	credentials?: Credentials;
	config?: WebSearchConfig;
}

export async function executeSearch(
	options: SearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const startedAt = Date.now();
	const config = options.config ?? loadConfig();
	const credentials = options.credentials ?? loadCredentials();

	let chain: ChainEntry[];
	try {
		chain = resolveChain(config, options.provider);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const parsedQuery = parseSearchQuery(options.query);
	const failures: { provider: { id: string; label: string }; error: unknown }[] = [];
	const timings: NonNullable<SearchResultDetails["timings"]> = [];
	let availableCount = 0;
	let lastAttempted: { id: string; label: string } | undefined;
	let failedResponseProvider: SearchResponse["provider"] = "none";

	for (const { provider, explicit } of chain) {
		lastAttempted = provider;

		// Availability gate: the automatic chain skips silently; an explicit
		// selection explains why it could not run and advances the chain.
		const available = explicit
			? explicitlyAvailable(provider, credentials)
			: provider.isAvailable(credentials);
		if (!available) {
			if (explicit) {
				failures.push({
					provider,
					error: new SearchProviderError(
						provider.id,
						`${provider.label} is not available. Configure its credentials or let the automatic chain choose.`,
						401,
					),
				});
				failedResponseProvider = provider.id;
			}
			continue;
		}
		availableCount += 1;

		const providerStartedAt = Date.now();
		try {
			const response = await provider.search({
				query: options.query,
				parsedQuery,
				limit: options.limit,
				recency: options.recency ?? config.recency ?? undefined,
				signal: options.signal,
				timeoutMs: config.timeoutSeconds * 1000,
				credentials,
				config,
				fetchImpl: options.fetch ?? fetch,
			});

			// Lenient constraint pass: enforce site:/inurl:/intitle:/filetype:/date
			// directives the provider could not honor natively, relaxing any single
			// dimension that would wipe out every result.
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			// A poisoned SERP passes every other check: 200, well-formed, sources
			// present, just not about the query. Gated on "does the query have free
			// text to compare against", NOT on `hasDirectives`: gating on that flag
			// meant one unenforceable operator (`-intext:x`, a malformed `after:`)
			// silently switched the guard off for the whole query.
			if (!looksRelevant(parsedQuery, finalResponse.sources)) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} returned results unrelated to the query; ignoring them.`,
					204,
				);
			}

			timings.push({ provider: provider.id, ms: Date.now() - providerStartedAt, ok: true });
			const failed = failureDetails(failures);
			const provenance = `Provider: ${provider.label} (${finalResponse.authMode ?? (explicit ? "pinned" : "primary")}), ${timings[timings.length - 1].ms}ms`;
			const text = formatForLLM(
				finalResponse,
				[...fallbackNotes(failed, provider), ...constraintNotes, ...parsedQuery.warnings],
				provenance,
			);
			return {
				content: [{ type: "text", text }],
				details: {
					response: finalResponse,
					...(failed.length > 0 ? { failures: failed } : {}),
					timings,
				},
			};
		} catch (error) {
			// Surface user cancellation immediately: an AbortError from fetch() must
			// not be swallowed as "this provider failed, try the next one".
			if (options.signal?.aborted) throw error;
			timings.push({ provider: provider.id, ms: Date.now() - providerStartedAt, ok: false });
			failedResponseProvider = provider.id;
			failures.push({ provider, error });
		}
	}

	if (availableCount === 0 && failures.length === 0) {
		// Zero candidates is a CONFIGURATION error, not an availability one: every id
		// was filtered out. Reporting "no provider is available" here sends the user
		// hunting for credentials that were never the problem.
		const message = options.provider
			? `Provider "${options.provider}" is not available. Configure its credentials.`
			: chain.length === 0
				? `The provider chain is empty, so there was nothing to try. Check \`chain\` / \`disabled\` in ${CONFIG_PATH} and PI_WEBSEARCH_CHAIN — typo'd or unknown ids are dropped, and \`public\` is never part of a chain (request it with provider: "public").`
				: "No provider in the chain is available. Every candidate was skipped for a missing credential — make sure the chain still contains a keyless provider such as exa, keenable, parallel, bing or duckduckgo.";
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message, timings },
		};
	}

	const failed = failureDetails(failures);
	const lastFailure = failures[failures.length - 1];
	const singleMessage = lastFailure
		? formatProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastAttempted?.label ?? "web search provider"}`;
	const message =
		failures.length > 1
			? `All web search providers failed: ${failures
					.map(f => `${f.provider.id}: ${formatProviderFailure(f.error, f.provider)}`)
					.join("; ")}`
			: singleMessage;

	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: {
			response: { provider: failedResponseProvider, sources: [] },
			error: message,
			failures: failed,
			timings,
		},
	};
}
