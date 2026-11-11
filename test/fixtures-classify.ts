/**
 * Offline fixtures for HTTP error classification.
 *
 * The failure mode being pinned: a wall arrived as HTTP 403 and was reported as
 * "authorization failed, check the API key" — while the API key was fine and the
 * real cause was the network. Classification order is the whole test.
 */

import { classifyProviderHttpError } from "../providers/utils.ts";

export interface Fixture {
	name: string;
	run: () => string | undefined;
}

/**
 * Verbatim body Firecrawl returned to keyless search from a VPN egress IP.
 * Note the status: 403, same as a bad key.
 */
const FIRECRAWL_VPN_BODY = JSON.stringify({
	success: false,
	error:
		"Unfortunately, your IP address looks like a VPN or proxy, so Firecrawl can't be used without an API key from here.",
});

export const classificationProbe: Fixture[] = [
	{
		name: "a 403 egress block is classified as a block, not as a bad key",
		run: () => {
			const error = classifyProviderHttpError("firecrawl", 403, FIRECRAWL_VPN_BODY);
			if (!error) return "returned undefined for a known egress block";
			// Must not BLAME the credential. Mentioning a key as one of several
			// remedies is fine; asserting it is the cause is the bug.
			if (/authorization failed|check the api key|invalid api key|rejected the api key/i.test(error.message)) {
				return `blamed the credential: "${error.message}"`;
			}
			if (!/network|egress|ip/i.test(error.message)) {
				return `did not name the network as the cause: "${error.message}"`;
			}
			if (error.status !== 429) return `expected status 429 for a wall, got ${error.status}`;
			return undefined;
		},
	},
	{
		name: "a plain 401 blames the credential",
		run: () => {
			const error = classifyProviderHttpError("brave", 401, '{"error":"invalid api key"}');
			if (!error) return "returned undefined for a 401";
			return error.status === 401 && /api key/i.test(error.message) ? undefined : `wrong mapping: ${error.message}`;
		},
	},
	{
		name: "an anti-bot body at HTTP 200 is still detected",
		run: () => {
			const error = classifyProviderHttpError("duckduckgo", 200, '<div class="anomaly-modal">slow down</div>');
			return error?.status === 429 ? undefined : "missed a 200-status wall body";
		},
	},
	{
		name: "a 429 without a wall body says rate limited",
		run: () => {
			const error = classifyProviderHttpError("parallel", 429, "you have hit the free-tier rate limit");
			return error?.status === 429 ? undefined : "missed a plain 429";
		},
	},
	{
		name: "a 500 is reported as upstream, not as auth",
		run: () => {
			const error = classifyProviderHttpError("kagi", 500, "internal server error");
			return error?.status === 500 && /upstream/i.test(error.message) ? undefined : "misclassified a 5xx";
		},
	},
	{
		name: "an unclassified status returns undefined so the caller supplies its own",
		run: () => {
			return classifyProviderHttpError("exa", 418, "teapot") === undefined ? undefined : "invented an error";
		},
	},
];
