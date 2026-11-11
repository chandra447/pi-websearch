/**
 * Configuration and credential discovery.
 *
 * Credentials come from environment variables only. Pi's auth storage
 * (`agent.db`, `AuthStorage`) is deliberately not consulted: it is an internal
 * surface with a broker-managed refresh pipeline, and a third-party extension
 * reading it would couple to something upstream can change (and risk racing a
 * token refresh). Env vars are explicit, per-process, documented, and
 * trivially testable.
 *
 * Everything is resolved lazily, inside the tool call, so `/reload` and a
 * changed environment take effect without restarting Pi.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Recency } from "./types.ts";

export interface Credentials {
	brave?: string;
	tavily?: string;
	exa?: string;
	firecrawl?: string;
	jina?: string;
	parallel?: string;
	keenable?: string;
	kagi?: string;
	deepseek?: string;
	/** SearXNG is configured by base URL, not by key. */
	searxngEndpoint?: string;
}

export interface WebSearchConfig {
	/** Provider ids in attempt order. Only keyless entries always run; keyed ones self-skip. */
	chain: string[];
	/** Ids removed from the chain even if listed in it. */
	disabled: string[];
	/** Per-provider transport ceiling, in seconds. Clamped to [1, 300]. */
	timeoutSeconds: number;
	defaultLimit: number;
	maxLimit: number;
	/** Applied when the caller omits `recency`. */
	recency: Recency | null;
	/** Where the effective config came from, surfaced by `/websearch`. */
	source: "default" | "file" | "env";
	/** Non-fatal problems (bad JSON, unknown ids) reported instead of thrown. */
	warnings: string[];
}

/**
 * Default chain, ordered by what was measured working from a real machine
 * (see README) rather than by vendor prestige.
 *
 *  1. `exa`       keyless MCP tool — ~0.5 s, LLM-grade relevance, not IP-gated.
 *  2. `keenable`  keyless public endpoint — ~0.4 s, clean JSON schema.
 *  3. `parallel`  keyless MCP tool — ~1 s, strongest excerpts, but the free
 *                 tier is quota-limited per IP, so it can answer 429.
 *  4. `bing`      plain-fetch HTML — the only mainstream engine that answered
 *                 with no challenge from a shared/VPN egress IP.
 *  5. `tavily`    keyed; skipped silently without a key.
 *  6. `brave`     keyed; skipped silently without a key.
 *  7. `duckduckgo` HTML — excellent from residential IPs, walled from
 *                 datacenter/VPN egress, so it sits behind the API services.
 *  8. `firecrawl` keyless path is IP-gated, keyed path is not.
 *  9-13. Keyed or challenge-prone: `searxng` needs a self-hosted endpoint,
 *                 `kagi`/`jina`/`deepseek` need keys, `startpage`/`bravehtml`
 *                 are challenge-prone scrapers, `marginalia` is a small index
 *                 that frequently has nothing.
 *
 * `public` is deliberately absent: fanning out to every keyless engine at once
 * must be an explicit `provider: "public"` choice, never an implicit fallback
 * that multiplies request volume. Same rule as oh-my-pi.
 */
export const DEFAULT_CHAIN = [
	"exa",
	"keenable",
	"parallel",
	"bing",
	"tavily",
	"brave",
	"duckduckgo",
	"firecrawl",
	"searxng",
	"kagi",
	"jina",
	"deepseek",
	"startpage",
	"bravehtml",
	"marginalia",
];

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 300;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_MAX_LIMIT = 20;

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search.json");

const ENV_KEYS = {
	brave: "BRAVE_API_KEY",
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
	jina: "JINA_API_KEY",
	parallel: "PARALLEL_API_KEY",
	keenable: "KEENABLE_API_KEY",
	kagi: "KAGI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	searxngEndpoint: "SEARXNG_ENDPOINT",
} as const;

/** Read credentials from the environment. Blank strings count as absent. */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
	const credentials: Credentials = {};
	for (const [field, name] of Object.entries(ENV_KEYS)) {
		const value = env[name];
		if (typeof value === "string" && value.trim().length > 0) {
			credentials[field as keyof Credentials] = value.trim();
		}
	}
	return credentials;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

function parseBooleanish(value: unknown): Recency | null {
	if (value === "day" || value === "week" || value === "month" || value === "year") return value;
	return null;
}

/**
 * Resolve the effective config: environment override > config file > defaults.
 *
 * Never throws. A malformed config file degrades to defaults with a recorded
 * warning, because an extension entry point that throws can break Pi startup,
 * and a broken config is not a reason to lose web search entirely.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
	const warnings: string[] = [];
	let chain = [...DEFAULT_CHAIN];
	let disabled: string[] = [];
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let defaultLimit = DEFAULT_LIMIT;
	let maxLimit = DEFAULT_MAX_LIMIT;
	let recency: Recency | null = null;
	let source: WebSearchConfig["source"] = "default";

	if (existsSync(CONFIG_PATH)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			if (parsed && typeof parsed === "object") {
				const file = parsed as Record<string, unknown>;
				if (Array.isArray(file.chain)) {
					chain = file.chain.filter((id): id is string => typeof id === "string");
				}
				if (Array.isArray(file.disabled)) {
					disabled = file.disabled.filter((id): id is string => typeof id === "string");
				}
				if (typeof file.timeoutSeconds === "number" && Number.isFinite(file.timeoutSeconds)) {
					timeoutSeconds = file.timeoutSeconds;
				}
				if (typeof file.defaultLimit === "number" && Number.isFinite(file.defaultLimit)) {
					defaultLimit = Math.trunc(file.defaultLimit);
				}
				if (typeof file.maxLimit === "number" && Number.isFinite(file.maxLimit)) {
					maxLimit = Math.trunc(file.maxLimit);
				}
				recency = parseBooleanish(file.recency);
				source = "file";
			}
		} catch (error) {
			warnings.push(
				`${CONFIG_PATH} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using defaults.`,
			);
		}
	}

	const envChain = env.PI_WEBSEARCH_CHAIN;
	if (typeof envChain === "string" && envChain.trim()) {
		chain = envChain
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		source = "env";
	}

	const envDisabled = env.PI_WEBSEARCH_DISABLE;
	if (typeof envDisabled === "string" && envDisabled.trim()) {
		disabled = envDisabled
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
	}

	const envTimeout = Number(env.PI_WEBSEARCH_TIMEOUT);
	if (env.PI_WEBSEARCH_TIMEOUT && Number.isFinite(envTimeout) && envTimeout > 0) {
		timeoutSeconds = envTimeout;
		source = "env";
	}

	timeoutSeconds = clamp(Math.round(timeoutSeconds), 1, MAX_TIMEOUT_SECONDS);
	maxLimit = clamp(maxLimit, 1, 100);
	defaultLimit = clamp(defaultLimit, 1, maxLimit);

	// `public` is an explicit-only aggregate: fanning out to every keyless engine
	// must be a deliberate choice, never an implicit fallback that multiplies
	// request volume. Same rule as omp.
	const filtered = chain.filter((id) => id !== "public" && !disabled.includes(id));
	const unknown = filtered.filter((id) => !KNOWN_PROVIDER_IDS.has(id));
	if (unknown.length) warnings.push(`Unknown provider id(s) in chain: ${unknown.join(", ")}.`);

	return {
		chain: filtered.filter((id) => KNOWN_PROVIDER_IDS.has(id)),
		disabled,
		timeoutSeconds,
		defaultLimit,
		maxLimit,
		recency,
		source,
		warnings,
	};
}

/** Kept here as a plain set so `config.ts` never imports the provider modules. */
export const KNOWN_PROVIDER_IDS = new Set([
	"parallel",
	"exa",
	"keenable",
	"bing",
	"firecrawl",
	"duckduckgo",
	"brave",
	"tavily",
	"startpage",
	"bravehtml",
	"searxng",
	"kagi",
	"jina",
	"deepseek",
	"marginalia",
	"public",
]);
