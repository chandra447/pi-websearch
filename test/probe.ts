/**
 * Verification harness for the web_search chain.
 *
 *   bun test/probe.ts --fixtures   offline assertions, no network
 *   bun test/probe.ts              live: one query end to end
 *   bun test/probe.ts --all        live: every query
 *
 * `--fixtures` exists because the bugs this file guards against are all
 * *silent*: a poisoned SERP, a directive that is parsed but not enforced, an
 * error that names the wrong cause. None of them throw, so none of them are
 * caught by "does a search return results". They are pinned here so they cannot
 * come back.
 */

import { classificationProbe } from "./fixtures-classify.ts";
import { loadConfig, loadCredentials } from "../config.ts";
import { applyQueryConstraints, looksRelevant, parseSearchQuery } from "../query.ts";
import { executeSearch } from "../search.ts";
import { allProviders } from "../providers/registry.ts";

// ---------------------------------------------------------------------------
// Offline fixtures
// ---------------------------------------------------------------------------

interface Fixture {
	name: string;
	run: () => string | undefined; // returns a failure reason, or undefined on pass
}

const CHATGPT_SERP = [
	{
		title: "GitHub - 0xk1h0/ChatGPT_DAN: ChatGPT DAN, Jailbreaks prompt",
		url: "https://github.com/0xk1h0/ChatGPT_DAN",
		snippet:
			"NOTE: As of 20230711, the DAN 12.0 prompt is working properly with Model GPT-3.5 All contributors are constantly investigating",
	},
	{ title: "OpenAI · GitHub", url: "https://github.com/openai/", snippet: "OpenAI has 278 repositories available." },
	{
		title: "不是说chat gpt是免费的吗，怎么只能免费问一次? - 知乎",
		url: "https://www.zhihu.com/question/606750758",
		snippet: "后来自己注册gpt账号",
	},
	{
		title: "如何评价ChatGPT更新的由GPT-6驱动的chat模式？",
		url: "https://www.zhihu.com/question/2091736254425649674",
		snippet: "Oct 8, 2026",
	},
];

const BROCCOLI_SERP = [
	{
		title: "The Best Broccoli Mash Recipe – Easy and Flavorful",
		url: "https://sagarecipes.com/broccoli-mash-recipe/",
		snippet: "Creamy mashed broccoli with butter.",
	},
	{
		title: "Broccoli Cheddar Mashed Potatoes Recipe - NYT Cooking",
		url: "https://cooking.nytimes.com/recipes/794328591-broccoli-cheddar-mashed-potatoes",
		snippet: "A Thanksgiving staple.",
	},
];

const SQLITE_SERP = [
	{
		title: "Write-Ahead Logging",
		url: "https://sqlite.org/wal.html",
		snippet: "Checkpoint starvation happens when readers prevent the writer from advancing.",
	},
	{
		title: "Checkpoint Starvation: connections vs. transactions",
		url: "https://sqlite.org/forum/info/7da967e0",
		snippet: "A busy WAL can starve the checkpoint.",
	},
];

const TOKIO_SERP = [
	{ title: "Tokio - An asynchronous Rust runtime", url: "https://tokio.rs/", snippet: "async runtime for Rust" },
	{
		title: "spawn_blocking in tokio::task",
		url: "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
		snippet: "Runs the closure on a blocking thread.",
	},
];

/** A SERP whose only overlap with a sqlite query is the substring `model`. */
const MODEL_ONLY_SERP = [
	{ title: "Model GPT-3.5 notes", url: "https://example.com/models", snippet: "All models listed here." },
];

const fixtures: Fixture[] = [
	{
		name: "guard rejects the broccoli SERP for a tokio query",
		run: () => {
			const q = parseSearchQuery("tokio async runtime");
			return looksRelevant(q, BROCCOLI_SERP) ? "accepted unrelated broccoli results" : undefined;
		},
	},
	{
		name: "guard rejects the ChatGPT SERP for a sqlite WAL query",
		run: () => {
			const q = parseSearchQuery("sqlite WAL mode checkpoint starvation");
			return looksRelevant(q, CHATGPT_SERP) ? "accepted unrelated ChatGPT results" : undefined;
		},
	},
	{
		name: "guard does not match a short token inside a longer word (mode/model)",
		run: () => {
			const q = parseSearchQuery("sqlite WAL mode checkpoint starvation");
			return looksRelevant(q, MODEL_ONLY_SERP)
				? "`mode` matched inside `model` — substring matching has regressed"
				: undefined;
		},
	},
	{
		name: "guard accepts genuinely relevant results",
		run: () => {
			if (!looksRelevant(parseSearchQuery("sqlite WAL mode checkpoint starvation"), SQLITE_SERP)) {
				return "rejected a correct sqlite SERP";
			}
			if (!looksRelevant(parseSearchQuery("tokio async runtime"), TOKIO_SERP)) {
				return "rejected a correct tokio SERP";
			}
			return undefined;
		},
	},
	{
		name: "guard is a no-op when the query has no free text",
		run: () => {
			const q = parseSearchQuery("site:docs.rs after:2024-01-01");
			return looksRelevant(q, BROCCOLI_SERP) ? undefined : "guard rejected a directives-only query";
		},
	},
	{
		name: "an unenforceable operator no longer disables the guard",
		run: () => {
			// `-intext:` is dropped by the parser, which used to flip hasDirectives
			// and switch the guard off for the whole query.
			const q = parseSearchQuery("-intext:spam tokio async runtime");
			return looksRelevant(q, BROCCOLI_SERP)
				? "guard was skipped because an unenforceable directive set hasDirectives"
				: undefined;
		},
	},
	{
		name: "`-intext:` reports that it was ignored",
		run: () => {
			const q = parseSearchQuery("-intext:spam rust");
			return q.warnings.some(w => w.includes("-intext:spam")) ? undefined : "silently discarded -intext:";
		},
	},
	{
		name: "an invalid date reports that it was ignored",
		run: () => {
			const q = parseSearchQuery("after:last-tuesday rust");
			return q.warnings.some(w => w.includes("not a valid date")) ? undefined : "silently discarded a bad after:";
		},
	},
	{
		name: "negation on a non-negatable directive reports rather than inverting",
		run: () => {
			const q = parseSearchQuery("-lang:en rust");
			if (q.lang !== undefined) return "applied the POSITIVE lang: for a negated operator";
			return q.warnings.some(w => w.includes("-lang:en")) ? undefined : "silently dropped -lang:";
		},
	},
	{
		name: "constraint relaxation drops an unsatisfiable dimension and reports it",
		run: () => {
			const q = parseSearchQuery("site:arxiv.org tokio async runtime");
			const { sources, dropped } = applyQueryConstraints(SQLITE_SERP, q);
			if (sources.length === 0) return "relaxation emptied the result set";
			return dropped.some(d => d.includes("arxiv.org")) ? undefined : "did not report the relaxed dimension";
		},
	},
	{
		name: "negated directives round-trip through parse, format and filter",
		run: () => {
			const q = parseSearchQuery("-intitle:blog -filetype:pdf -inurl:archive tokio");
			if (q.excludedInTitle[0] !== "blog" || q.excludedFiletypes[0] !== "pdf" || q.excludedInUrl[0] !== "archive") {
				return `parse lost a negation: ${JSON.stringify([q.excludedInTitle, q.excludedFiletypes, q.excludedInUrl])}`;
			}
			const { sources } = applyQueryConstraints(
				[{ title: "Blog about tokio", url: "https://x.dev/a" }, { title: "Tokio docs", url: "https://tokio.rs" }],
				q,
			);
			return sources.length === 1 && sources[0].title === "Tokio docs"
				? undefined
				: `filter kept the wrong set: ${JSON.stringify(sources.map(s => s.title))}`;
		},
	},
	...classificationProbe,
];

async function runFixtures(): Promise<number> {
	console.log("offline fixtures\n");
	let failed = 0;
	for (const fixture of fixtures) {
		const reason = fixture.run();
		if (reason) {
			failed += 1;
			console.log(`  ✗ ${fixture.name}\n      ${reason}`);
		} else {
			console.log(`  ✓ ${fixture.name}`);
		}
	}

	// Async fixtures: the empty-chain diagnosis needs a real executeSearch.
	const emptyChain = await executeSearch({ query: "rust", config: { ...loadConfig(), chain: [] } });
	const emptyMessage = emptyChain.details.error ?? "";
	if (emptyMessage.includes("chain is empty")) {
		console.log("  ✓ an empty configured chain is diagnosed as an empty chain");
	} else {
		failed += 1;
		console.log(`  ✗ an empty configured chain is diagnosed as an empty chain\n      got: ${emptyMessage.slice(0, 120)}`);
	}

	console.log(`\n${failed === 0 ? "all fixtures pass" : `${failed} fixture(s) FAILED`}`);
	return failed;
}

// ---------------------------------------------------------------------------
// Live queries
// ---------------------------------------------------------------------------

const QUERIES = [
	{ label: "plain", query: "rust async runtime comparison tokio vs async-std" },
	{ label: "directives", query: 'site:docs.rs "async fn" -tokio after:2024-01-01' },
	{ label: "recency", query: "claude opus release notes", recency: "month" as const },
	{ label: "nonsense", query: "zqxjkvb wobbleflange 8f3a2c proprietary" },
];

async function runLive(only?: string): Promise<number> {
	const queries = only && only !== "--all" ? QUERIES.filter(q => q.label === only) : QUERIES;

	console.log(`config chain: ${loadConfig().chain.join(", ")}`);
	console.log(`credentials: ${Object.keys(loadCredentials()).join(", ") || "(none)"}`);
	console.log(`providers:   ${allProviders().map(p => p.id).join(", ")}\n`);

	let failures = 0;
	for (const { label, query, recency } of queries) {
		console.log(`=== ${label}: ${query}`);
		const started = Date.now();
		const result = await executeSearch({ query, recency, limit: 5 });
		const elapsed = Date.now() - started;
		const { response, failures: failed, timings, error } = result.details;

		for (const timing of timings ?? []) {
			console.log(`    ${timing.ok ? "✓" : "✗"} ${timing.provider.padEnd(11)} ${timing.ms}ms`);
		}
		if (error) {
			failures += 1;
			console.log(`    ERROR (${elapsed}ms): ${error}\n`);
			continue;
		}
		console.log(
			`    answered by ${response.provider} (${response.authMode ?? "?"}) in ${elapsed}ms — ${response.sources.length} sources`,
		);
		if (failed?.length) console.log(`    fell back after: ${failed.map(f => f.provider).join(", ")}`);
		const first = response.sources[0];
		if (first) console.log(`    [1] ${first.title}\n        ${first.url}`);
		for (const line of result.content[0].text.split("\n").slice(0, 3)) {
			if (line.startsWith("Note:")) console.log(`    ${line.slice(0, 160)}`);
		}
		console.log();
	}
	console.log(failures === 0 ? "all queries answered" : `${failures} quer${failures === 1 ? "y" : "ies"} failed`);
	return failures;
}

const arg = process.argv[2];
const failed = arg === "--fixtures" ? await runFixtures() : await runLive(arg);
process.exit(failed === 0 ? 0 : 1);
