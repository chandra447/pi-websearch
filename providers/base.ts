/**
 * Provider contract.
 *
 * Deliberately an interface plus factory objects, not an abstract class:
 * `test/probe.ts` runs the sources under bare `node --experimental-strip-types`,
 * where class modifier syntax (`abstract`, parameter properties) is not
 * erasable. Interfaces cost nothing at runtime and behave identically here,
 * since no provider shares implementation through inheritance.
 */

import type { Credentials, WebSearchConfig } from "../config.ts";
import type { StructuredQuery } from "../query.ts";
import type { Recency, SearchResponse } from "../types.ts";

export interface SearchParams {
	/** The caller's raw query, exactly as typed. */
	query: string;
	/** Parsed once by the orchestrator and shared by every candidate. */
	parsedQuery: StructuredQuery;
	limit?: number;
	recency?: Recency;
	/** Tool-call cancellation. Must reach every `fetch`. */
	signal?: AbortSignal;
	/** Hard ceiling for this provider's transport, in milliseconds. */
	timeoutMs: number;
	credentials: Credentials;
	config: WebSearchConfig;
	/** Injected for tests; production calls use the global `fetch`. */
	fetchImpl: typeof fetch;
}

export interface SearchProvider {
	readonly id: string;
	readonly label: string;
	/**
	 * Whether this provider can serve a request right now.
	 *
	 * Called once per candidate per search, so it must stay synchronous and
	 * cheap: reading a credential object, never a network probe or file read.
	 * Returning `false` in the automatic chain means "skip silently"; it is not
	 * a failure and must not appear in the fallback note. Keyless providers
	 * return `true` unconditionally.
	 */
	isAvailable(credentials: Credentials): boolean;

	/**
	 * Whether an explicit `provider: "<id>"` selection should run even though
	 * {@link isAvailable} says no. Used for providers with a degraded but
	 * documented unauthenticated path, so asking for one by name still works
	 * instead of erroring out. Defaults to mirroring `isAvailable`.
	 */
	isExplicitlyAvailable?(credentials: Credentials): boolean;

	search(params: SearchParams): Promise<SearchResponse>;
}

/** `true` when an explicit selection should run this provider. */
export function explicitlyAvailable(provider: SearchProvider, credentials: Credentials): boolean {
	if (provider.isExplicitlyAvailable) return provider.isExplicitlyAvailable(credentials);
	return provider.isAvailable(credentials);
}
