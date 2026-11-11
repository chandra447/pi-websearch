/**
 * Google-style query parsing, per-provider query formatting, and the lenient
 * constraint post-filter.
 *
 * Ported from oh-my-pi's `web/search/query.ts` (850 lines there; this is the
 * subset that every provider shipped here can actually honor). The design
 * rule that matters: parsing is *best effort and non-destructive*. A directive
 * is extracted so a provider can map it to a native API field, but if the
 * provider cannot honor it the filter below relaxes it rather than returning
 * an empty result set. A slightly-wider answer beats no answer.
 */

import type { SearchSource } from "./types.ts";

export interface StructuredQuery {
	/** The caller's query, untouched. */
	raw: string;
	/** Plain terms, directive-free. */
	words: string[];
	/** `"quoted phrase"` values, quotes stripped. */
	phrases: string[];
	/** `-term` / `-"phrase"` values. */
	exclusions: string[];
	sites: string[];
	excludedSites: string[];
	/** ISO `YYYY-MM-DD`, already validated. */
	after?: string;
	before?: string;
	inUrl: string[];
	/** `-inurl:` values — none may appear in the URL. */
	excludedInUrl: string[];
	inTitle: string[];
	/** `-intitle:` values — none may appear in the title. */
	excludedInTitle: string[];
	inText: string[];
	filetype?: string;
	/** `-filetype:` values — none may match. */
	excludedFiletypes: string[];
	lang?: string;
	/** Consecutive terms around `OR`; empty unless the query has one. */
	orGroups: string[][];
	/** A directive or `OR` was present, so the raw string is not a clean query. */
	hasDirectives: boolean;
	/** At least one directive that the post-filter can enforce. */
	hasConstraints: boolean;
	/**
	 * Directives that were recognised but could not be honored. The orchestrator
	 * surfaces these as `Note:` lines, because silently accepting an operator you
	 * do not implement is indistinguishable from honoring it.
	 */
	warnings: string[];
}

const DIRECTIVES = new Set([
	"site",
	"after",
	"before",
	"inurl",
	"intitle",
	"intext",
	"filetype",
	"lang",
	"language",
]);

interface Token {
	value: string;
	quoted: boolean;
	negated: boolean;
}

/**
 * Split a query into tokens, preserving whether each was quoted or negated.
 * Quotes matter semantically: `site:foo` is a directive, `"site:foo"` is a
 * phrase that happens to contain a colon.
 */
function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;

		let negated = false;
		// A leading `-` negates, but only when something follows it.
		if (input[i] === "-" && i + 1 < input.length && !/\s/.test(input[i + 1])) {
			negated = true;
			i++;
		}

		if (input[i] === '"') {
			i++;
			let value = "";
			while (i < input.length && input[i] !== '"') value += input[i++];
			i++; // closing quote (or end of input)
			if (value.trim()) tokens.push({ value: value.trim(), quoted: true, negated });
			continue;
		}

		let value = "";
		while (i < input.length && !/\s/.test(input[i])) {
			if (input[i] === '"') {
				// Quote opening mid-token, e.g. `intitle:"a b"` is already handled
				// by the directive branch; this absorbs `foo"bar baz"`.
				i++;
				while (i < input.length && input[i] !== '"') value += input[i++];
				i++;
				continue;
			}
			value += input[i++];
		}
		if (value) tokens.push({ value, quoted: false, negated });
	}
	return tokens;
}

/** Normalize a date directive to ISO `YYYY-MM-DD`, or drop it. */
function toIsoDate(value: string): string | undefined {
	const trimmed = value.trim();
	const dashed = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
	if (!dashed) return undefined;
	const [, y, m, d] = dashed;
	const month = Number(m);
	const day = Number(d);
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `site:https://foo.com/bar` → `foo.com`; the post-filter and APIs want bare hosts. */
function stripScheme(value: string): string {
	return value
		.trim()
		.replace(/^[a-z]+:\/\//i, "")
		.replace(/\/.*$/, "")
		.replace(/^\*\./, "")
		.toLowerCase();
}

export function parseSearchQuery(raw: string): StructuredQuery {
	const parsed: StructuredQuery = {
		raw,
		words: [],
		phrases: [],
		exclusions: [],
		sites: [],
		excludedSites: [],
		inUrl: [],
		excludedInUrl: [],
		inTitle: [],
		excludedInTitle: [],
		inText: [],
		excludedFiletypes: [],
		orGroups: [],
		hasDirectives: false,
		hasConstraints: false,
		warnings: [],
	};

	const sequence: (string | null)[] = []; // null marks an OR boundary

	for (const token of tokenize(raw)) {
		if (token.quoted) {
			if (token.negated) parsed.exclusions.push(token.value);
			else parsed.phrases.push(token.value);
			continue;
		}

		const directive = /^([a-zA-Z]+):(.*)$/s.exec(token.value);
		if (directive) {
			const name = directive[1].toLowerCase();
			const value = directive[2].trim();
			if (DIRECTIVES.has(name) && value) {
				parsed.hasDirectives = true;
				switch (name) {
					case "site": {
						const host = stripScheme(value);
						if (host) (token.negated ? parsed.excludedSites : parsed.sites).push(host);
						break;
					}
					case "after":
					case "before": {
						const iso = toIsoDate(value);
						if (iso && !token.negated) {
							if (name === "after") parsed.after = iso;
							else parsed.before = iso;
						} else if (iso) {
							parsed.warnings.push(`\`-${name}:${value}\` was ignored: \`${name}:\` cannot be negated`);
						} else {
							parsed.warnings.push(
								`\`${token.negated ? "-" : ""}${name}:${value}\` was ignored: it is not a valid date (expected YYYY-MM-DD)`,
							);
						}
						break;
					}
					case "inurl":
						(token.negated ? parsed.excludedInUrl : parsed.inUrl).push(value);
						break;
					case "intitle":
						(token.negated ? parsed.excludedInTitle : parsed.inTitle).push(value);
						break;
					case "intext":
						// No `-intext:` dimension: snippets are partial, so a negative
						// assertion cannot be enforced leniently. Rewriting it as a plain
						// exclusion would change the operator's meaning — so say so rather
						// than accept an operator that does nothing.
						if (!token.negated) parsed.inText.push(value);
						else parsed.warnings.push(`\`-intext:${value}\` was ignored: negative body matches cannot be verified`);
						break;
					case "filetype": {
						const ext = value.replace(/^\./, "").toLowerCase();
						if (token.negated) parsed.excludedFiletypes.push(ext);
						else parsed.filetype = ext;
						break;
					}
					case "lang":
					case "language":
						if (token.negated) {
							parsed.warnings.push(`\`-${name}:${value}\` was ignored: \`lang:\` cannot be negated`);
						} else {
							parsed.lang = value.toLowerCase().replace(/_/g, "-");
						}
						break;
					default:
						break;
				}
				continue;
			}
		}

		if (!token.negated && (token.value === "OR" || token.value === "|")) {
			parsed.hasDirectives = true;
			sequence.push(null);
			continue;
		}

		if (token.negated) parsed.exclusions.push(token.value);
		else sequence.push(token.value);
	}

	// Fold the OR-separated sequence back into plain words plus groups.
	let group: string[] = [];
	for (const entry of sequence) {
		if (entry === null) {
			if (group.length) parsed.orGroups.push(group);
			group = [];
			continue;
		}
		group.push(entry);
		parsed.words.push(entry);
	}
	if (group.length) parsed.orGroups.push(group);
	if (parsed.orGroups.length < 2) parsed.orGroups = [];

	parsed.hasConstraints = Boolean(
		parsed.sites.length ||
			parsed.excludedSites.length ||
			parsed.after ||
			parsed.before ||
			parsed.inUrl.length ||
			parsed.excludedInUrl.length ||
			parsed.inTitle.length ||
			parsed.excludedInTitle.length ||
			parsed.inText.length ||
			parsed.filetype ||
			parsed.excludedFiletypes.length ||
			parsed.exclusions.length,
	);

	return parsed;
}

/**
 * Operators a target understands. Anything not listed is stripped from the
 * outgoing query and left to the lenient post-filter, which is why a provider
 * can advertise `site: false` without losing the constraint.
 */
export interface QuerySyntax {
	phrases?: boolean;
	negation?: boolean;
	or?: boolean;
	site?: boolean;
	dateRange?: boolean;
	inUrl?: boolean;
	inTitle?: boolean;
	inText?: boolean;
	filetype?: boolean;
}

const quoteIfNeeded = (value: string): string => (/[\s"]/.test(value) ? `"${value}"` : value);

/**
 * Rebuild a provider-facing query string from the structured form, keeping
 * only the operators in `syntax`. Order is stable so a formatted query is
 * cache-friendly and diffable in tests.
 */
export function formatQuery(query: StructuredQuery, syntax: QuerySyntax): string {
	const parts: string[] = [];

	if (syntax.or && query.orGroups.length > 1) {
		// The OR groups already contain every plain word, so they replace them.
		const groups = query.orGroups.map((group) => group.map(quoteIfNeeded).join(" "));
		parts.push(`(${groups.join(" OR ")})`);
	} else {
		for (const word of query.words) parts.push(quoteIfNeeded(word));
	}

	if (syntax.phrases) for (const phrase of query.phrases) parts.push(`"${phrase}"`);
	if (syntax.negation) for (const term of query.exclusions) parts.push(`-${quoteIfNeeded(term)}`);
	if (syntax.site) {
		for (const host of query.sites) parts.push(`site:${host}`);
		for (const host of query.excludedSites) parts.push(`-site:${host}`);
	}
	if (syntax.dateRange) {
		if (query.after) parts.push(`after:${query.after}`);
		if (query.before) parts.push(`before:${query.before}`);
	}
	if (syntax.filetype) {
		if (query.filetype) parts.push(`filetype:${query.filetype}`);
		for (const value of query.excludedFiletypes) parts.push(`-filetype:${value}`);
	}
	if (syntax.inUrl) {
		for (const value of query.inUrl) parts.push(`inurl:${value}`);
		for (const value of query.excludedInUrl) parts.push(`-inurl:${value}`);
	}
	if (syntax.inTitle) {
		for (const value of query.inTitle) parts.push(`intitle:${value}`);
		for (const value of query.excludedInTitle) parts.push(`-intitle:${value}`);
	}
	if (syntax.inText) for (const value of query.inText) parts.push(`intext:${value}`);

	const formatted = parts.join(" ").trim();
	// A query made only of constraints (e.g. bare `site:foo.com`) would format to
	// just the operator; fall back to the raw text so the engine still has input.
	return formatted.length > 0 ? formatted : query.raw;
}

/**
 * Formatting for HTML scrapers, which parse the human-facing operator set but
 * reject API-only parameters. Identical to {@link formatQuery} by construction;
 * kept as its own name because the two diverge as soon as a scraper-specific
 * quirk appears (DDG strips `after:`/`before:`, for example).
 */
export function formatScraperQuery(query: StructuredQuery, syntax: QuerySyntax): string {
	return formatQuery(query, syntax);
}

const hostMatches = (url: string, hosts: string[]): boolean => {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return false;
	}
	return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
};

const filetypeMatches = (url: string, filetype: string): boolean => {
	try {
		const path = new URL(url).pathname.toLowerCase();
		return path.endsWith(`.${filetype}`);
	} catch {
		return false;
	}
};

/** `true` when the source's date satisfies a bound; undated sources always pass. */
function afterBound(source: SearchSource, bound: string): boolean {
	const date = source.publishedDate?.slice(0, 10);
	if (!date) return true; // cannot disprove it — stay lenient
	return date >= bound;
}

function beforeBound(source: SearchSource, bound: string): boolean {
	const date = source.publishedDate?.slice(0, 10);
	if (!date) return true;
	return date <= bound;
}

/**
 * Apply the constraints the provider could not honor natively, one dimension
 * at a time, dropping any single dimension that would eliminate every
 * remaining result.
 *
 * Each dimension is tried independently against the *current* set, so a query
 * with two unsatisfiable constraints loses both rather than keeping whichever
 * happened to run first. The loop also stops narrowing once one result
 * survives: with a single candidate left there is nothing to choose between,
 * and further filtering can only destroy the answer.
 *
 * Returns the surviving sources plus the labels of relaxed dimensions, which
 * the orchestrator turns into `Note:` lines above the results.
 */
export function applyQueryConstraints(
	sources: SearchSource[],
	query: StructuredQuery,
): { sources: SearchSource[]; dropped: string[] } {
	const dropped: string[] = [];
	let current = sources;

	const dimensions: { label: string; keep: (source: SearchSource) => boolean }[] = [];

	if (query.sites.length) {
		dimensions.push({ label: `site:${query.sites.join(" site:")}`, keep: (s) => hostMatches(s.url, query.sites) });
	}
	if (query.excludedSites.length) {
		dimensions.push({
			label: `-site:${query.excludedSites.join(" -site:")}`,
			keep: (s) => !hostMatches(s.url, query.excludedSites),
		});
	}
	if (query.filetype) {
		dimensions.push({ label: `filetype:${query.filetype}`, keep: (s) => filetypeMatches(s.url, query.filetype!) });
	}
	if (query.inUrl.length) {
		dimensions.push({
			label: `inurl:${query.inUrl.join(" ")}`,
			keep: (s) => query.inUrl.every((value) => s.url.toLowerCase().includes(value.toLowerCase())),
		});
	}
	if (query.excludedFiletypes.length) {
		dimensions.push({
			label: `-filetype:${query.excludedFiletypes.join(" -filetype:")}`,
			keep: (s) => !query.excludedFiletypes.some((ext) => filetypeMatches(s.url, ext)),
		});
	}
	if (query.excludedInUrl.length) {
		dimensions.push({
			label: `-inurl:${query.excludedInUrl.join(" -inurl:")}`,
			keep: (s) => !query.excludedInUrl.some((value) => s.url.toLowerCase().includes(value.toLowerCase())),
		});
	}
	if (query.excludedInTitle.length) {
		dimensions.push({
			label: `-intitle:${query.excludedInTitle.join(" -intitle:")}`,
			keep: (s) => !query.excludedInTitle.some((value) => s.title.toLowerCase().includes(value.toLowerCase())),
		});
	}
	if (query.inTitle.length) {
		dimensions.push({
			label: `intitle:${query.inTitle.join(" ")}`,
			keep: (s) => query.inTitle.every((value) => s.title.toLowerCase().includes(value.toLowerCase())),
		});
	}
	if (query.inText.length) {
		dimensions.push({
			label: `intext:${query.inText.join(" ")}`,
			keep: (s) =>
				query.inText.every((value) =>
					`${s.title} ${s.snippet ?? ""}`.toLowerCase().includes(value.toLowerCase()),
				),
		});
	}
	if (query.exclusions.length) {
		dimensions.push({
			label: `-${query.exclusions.join(" -")}`,
			keep: (s) =>
				!query.exclusions.some((term) =>
					`${s.title} ${s.snippet ?? ""}`.toLowerCase().includes(term.toLowerCase()),
				),
		});
	}
	if (query.after) {
		dimensions.push({ label: `after:${query.after}`, keep: (s) => afterBound(s, query.after!) });
	}
	if (query.before) {
		dimensions.push({ label: `before:${query.before}`, keep: (s) => beforeBound(s, query.before!) });
	}

	for (const dimension of dimensions) {
		if (current.length <= 1) break;
		const narrowed = current.filter(dimension.keep);
		if (narrowed.length === 0) dropped.push(dimension.label);
		else current = narrowed;
	}

	return { sources: current, dropped };
}

const STOPWORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "your", "with", "from", "this", "that", "these", "those",
	"how", "why", "what", "when", "where", "which", "who", "can", "could", "should", "would", "does", "did",
	"was", "were", "has", "have", "had", "get", "got", "use", "using", "about", "into", "than", "then",
	"there", "their", "them", "its", "vs", "versus", "best", "new", "all", "any", "latest",
]);

/** Characters that split a result's title/url/snippet into comparable words. */
const WORD_SPLIT = /[^a-z0-9+#._-]+/;

/**
 * The free-text vocabulary of a query, used as the relevance signal. Built from
 * the parsed terms rather than the raw string, so operators (`site:`, `after:`)
 * cannot contribute a "word" that a result happens to contain.
 */
export function relevanceTokens(query: StructuredQuery): string[] {
	const tokens = [...query.words, ...query.phrases]
		.flatMap((term) => term.toLowerCase().split(WORD_SPLIT))
		.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
	return [...new Set(tokens)];
}

/**
 * Reject a result set that shares no vocabulary with the query.
 *
 * This is not paranoia. From a shared/VPN egress IP, Bing answers
 * `tokio async runtime` with broccoli-recipe pages: HTTP 200, a correct
 * `<title>`, ten well-formed `b_algo` blocks, and body text from somebody
 * else's search. Every structural check passes, so a chain that only asks "did
 * sources come back" hands the model confident nonsense.
 *
 * Matching is per WORD, not per substring. An earlier version used
 * `haystack.includes(token)` and the token `mode` matched inside `model`, so a
 * query about SQLite WAL mode accepted a SERP of ChatGPT repos. Short tokens
 * recur as fragments of unrelated words; a boundary is the difference between a
 * guard and a rubber stamp.
 *
 * Inflection is tolerated only on longer tokens (`checkpoint` matches
 * `checkpoints`), because a prefix that long is real evidence.
 */
export function looksRelevant(query: StructuredQuery, sources: readonly SearchSource[]): boolean {
	if (sources.length === 0) return true;
	const tokens = relevanceTokens(query);
	// No free text to compare against (a directives-only query). Nothing to check.
	if (tokens.length === 0) return true;

	const words = new Set<string>();
	for (const source of sources.slice(0, 5)) {
		const text = `${source.title} ${source.url} ${source.snippet ?? ""}`.toLowerCase();
		for (const word of text.split(WORD_SPLIT)) {
			if (word.length >= 3) words.add(word);
		}
	}

	return tokens.some((token) => {
		if (words.has(token)) return true;
		if (token.length < 5) return false;
		for (const word of words) {
			if (word.startsWith(token)) return true;
		}
		return false;
	});
}

/**
 * Resolve `recency` to an absolute lower bound, for APIs that take a date
 * rather than an enum. UTC to keep it reproducible across machines.
 */
export function recencyAfterDate(recency: string): string {
	const now = new Date();
	const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : 365;
	const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return from.toISOString().slice(0, 10);
}
