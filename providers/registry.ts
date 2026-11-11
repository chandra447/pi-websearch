/**
 * Provider registry.
 *
 * A flat list, not lazy `import()` loaders like oh-my-pi: that indirection
 * exists to keep Puppeteer and SSE stacks out of omp's startup, and there is
 * nothing comparable here — sixteen small `fetch` modules with no optional
 * dependencies. Static imports mean a provider that fails to parse fails
 * loudly at load instead of silently at search time.
 *
 * Registry order is the fallback priority when the config names no chain.
 */

import type { SearchProvider } from "./base.ts";
import { BingProvider } from "./bing.ts";
import { braveProvider } from "./brave.ts";
import { BraveHtmlProvider } from "./bravehtml.ts";
import { deepseekProvider } from "./deepseek.ts";
import { duckDuckGoProvider } from "./duckduckgo.ts";
import { exaProvider } from "./exa.ts";
import { firecrawlProvider } from "./firecrawl.ts";
import { jinaProvider } from "./jina.ts";
import { kagiProvider } from "./kagi.ts";
import { keenableProvider } from "./keenable.ts";
import { MarginaliaProvider } from "./marginalia.ts";
import { parallelProvider } from "./parallel.ts";
import { PublicWebProvider } from "./public.ts";
import { searxngProvider } from "./searxng.ts";
import { StartpageProvider } from "./startpage.ts";
import { tavilyProvider } from "./tavily.ts";

/**
 * Order mirrors `DEFAULT_CHAIN` in `config.ts`: keyless-where-possible first,
 * challenge-prone scrapers last, keyed services positioned by measured quality.
 */
const PROVIDERS: readonly SearchProvider[] = [
	exaProvider,
	keenableProvider,
	parallelProvider,
	new BingProvider(),
	tavilyProvider,
	braveProvider,
	duckDuckGoProvider,
	firecrawlProvider,
	searxngProvider,
	kagiProvider,
	jinaProvider,
	deepseekProvider,
	new StartpageProvider(),
	new BraveHtmlProvider(),
	new MarginaliaProvider(),
	new PublicWebProvider(),
];

const index = new Map<string, SearchProvider>(PROVIDERS.map(provider => [provider.id, provider]));

/** Every registered provider, in default priority order. */
export function allProviders(): readonly SearchProvider[] {
	return PROVIDERS;
}

/** Every registered provider id, in default priority order. */
export function providerIds(): string[] {
	return PROVIDERS.map(provider => provider.id);
}

/** Resolve a provider by id, or `undefined` when the id is not registered. */
export function getProvider(id: string): SearchProvider | undefined {
	return index.get(id);
}

/** Whether `id` names a registered provider. */
export function isProviderId(id: string): boolean {
	return index.has(id);
}

/** Mirrors the interface default for providers that omit the optional hook. */
export function explicitlyAvailable(provider: SearchProvider, credentials: Parameters<SearchProvider["isAvailable"]>[0]): boolean {
	return provider.isExplicitlyAvailable ? provider.isExplicitlyAvailable(credentials) : provider.isAvailable(credentials);
}
