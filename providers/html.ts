/**
 * HTML helpers for the keyless scraper providers.
 *
 * Everything transport-related (timeouts, JSON reads, error classification)
 * lives in `utils.ts`; this module only holds what is specific to parsing a
 * scraped result page, plus the browser-ish header set every scraper needs.
 * Several engines answer `403` or a challenge page to the default undici user
 * agent, so the header set is not cosmetic.
 */

export const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent": USER_AGENT,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Upgrade-Insecure-Requests": "1",
};

/** Named entities these engines actually emit. Numeric refs are decoded generically. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
	middot: "·",
	bull: "•",
};

/**
 * Strip inline tags (result pages wrap query terms in `<b>`), unescape the
 * entities engines emit, and fold whitespace into single spaces.
 */
export function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Read a response body, refusing to buffer unbounded HTML.
 *
 * A challenged or error page can be megabytes; parsing the first 4 MB is
 * always enough and keeps a hostile redirect from exhausting memory.
 */
export async function readBodyCapped(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
	const text = await response.text();
	return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}
