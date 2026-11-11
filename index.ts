/**
 * Web Search — a Pi extension that ports oh-my-pi's fallback-chain web search.
 *
 * This file is registration glue only: the chain, the fallback semantics and
 * the formatting all live in `search.ts`, which imports nothing from Pi so it
 * can be tested standalone. See `search.ts` for the design notes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { CONFIG_PATH, DEFAULT_LIMIT, DEFAULT_MAX_LIMIT, loadConfig, loadCredentials } from "./config.ts";
import { allProviders, getProvider } from "./providers/registry.ts";
import { executeSearch } from "./search.ts";
import { providerLabel, type Recency, type SearchResultDetails } from "./types.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const searchSchema = Type.Object({
	query: Type.String({
		description:
			"Search query. Supports Google-style directives: site:/domain:, -site:, inurl:, intitle:, intext:, filetype:, lang:, after:/before:, quoted phrases, -exclusions, OR.",
	}),
	recency: Type.Optional(
		StringEnum(["day", "week", "month", "year"] as const, {
			description: "Only return results published within this window, where the provider supports it.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}).` }),
	),
	provider: Type.Optional(
		Type.String({
			description: "Pin a single provider instead of walking the fallback chain. Use /websearch status to list them.",
		}),
	),
});

const DESCRIPTION = `Search the web for up-to-date information.

Results come from a fallback chain of providers: each candidate is tried in order and the first one that returns usable results answers. When a provider fails the next one runs, and the response opens with a \`Note:\` naming which provider answered and why the others failed. Several providers work without any API key, so this tool works out of the box.

Query syntax: Google-style directives are parsed and honored. \`site:\` / \`-site:\`, \`inurl:\`, \`intitle:\`, \`intext:\`, \`filetype:\`, \`lang:\`, \`after:\`/\`before:\`, quoted phrases, \`-exclusions\`, and \`OR\`. Directives are mapped onto each provider's native filters where they exist; otherwise they are applied as a lenient post-filter, and a directive that would eliminate every result is relaxed with a note rather than returning nothing.

Pass \`recency\` to filter by publish date. Pass \`provider\` to pin one provider (see \`/websearch status\`).`;

/** Human-readable snapshot of the chain and which providers can actually run. */
function describeStatus(): string {
	const config = loadConfig();
	const credentials = loadCredentials();
	const lines: string[] = [];

	lines.push(`config: ${CONFIG_PATH} (${config.source})`);
	lines.push(`timeout: ${config.timeoutSeconds}s per provider · limit: default ${config.defaultLimit}, max ${config.maxLimit}`);
	if (config.recency) lines.push(`default recency: ${config.recency}`);
	if (config.disabled.length > 0) lines.push(`disabled: ${config.disabled.join(", ")}`);
	for (const warning of config.warnings) lines.push(`warning: ${warning}`);

	lines.push("");
	lines.push(`chain (${config.chain.length}):`);
	for (const [position, id] of config.chain.entries()) {
		const provider = getProvider(id);
		if (!provider) continue;
		const available = provider.isAvailable(credentials);
		lines.push(
			`  ${String(position + 1).padStart(2)}. ${available ? "✓" : "·"} ${id.padEnd(11)} ${providerLabel(id).padEnd(14)} ${available ? "ready" : "no credential"}`,
		);
	}

	const offChain = allProviders()
		.map(provider => provider.id)
		.filter(id => !config.chain.includes(id));
	if (offChain.length > 0) lines.push(`\nnot in chain: ${offChain.join(", ")}`);

	lines.push("");
	lines.push("✓ = will be tried · · = no credential, skipped silently by the automatic chain");
	lines.push('Pin one with web_search(provider: "bing"), or aggregate every keyless engine with "public".');
	return lines.join("\n");
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: DESCRIPTION,
		promptSnippet: "Search the web for up-to-date information (fallback chain across multiple providers)",
		promptGuidelines: [
			"Use web_search when the answer depends on current information, release notes, versions, or anything that changed after training.",
			"web_search accepts Google-style query directives (site:, -site:, inurl:, intitle:, filetype:, after:, before:, quoted phrases, -exclusions, OR) and applies them across providers.",
		],
		parameters: searchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Searching: ${params.query}` }],
				details: { response: { provider: "none", sources: [] } },
			});

			const config = loadConfig();
			const requested = typeof params.limit === "number" ? params.limit : config.defaultLimit;
			const result = await executeSearch({
				query: params.query,
				limit: Math.min(Math.max(1, Math.trunc(requested)), config.maxLimit),
				recency: params.recency as Recency | undefined,
				provider: params.provider,
				signal,
				config,
			});

			// Cap what the model sees; a wide chain can otherwise return a lot of text.
			const truncation = truncateHead(result.content[0].text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			if (!truncation.truncated) return result;
			return {
				...result,
				content: [
					{
						type: "text" as const,
						text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Narrow the query or lower \`limit\`.]`,
					},
				],
			};
		},

		// The default renderer prints the raw result text, which buries the
		// provenance below the collapsed fold and dumps a truncated source list.
		// These two slots put the answering provider on the tool row itself, so
		// `web_search → Exa (api_key) · 5 sources · 1.8s` is visible without
		// expanding anything.
		renderCall(args, theme) {
			const row = new Text("", 0, 0);
			let line = theme.fg("toolTitle", theme.bold("web_search "));
			line += theme.fg("muted", `"${args.query}"`);
			const flags: string[] = [];
			if (args.provider) flags.push(`provider=${args.provider}`);
			if (args.recency) flags.push(`recency=${args.recency}`);
			if (typeof args.limit === "number") flags.push(`limit=${args.limit}`);
			if (flags.length > 0) line += ` ${theme.fg("dim", flags.join(" "))}`;
			row.setText(line);
			return row;
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as SearchResultDetails | undefined;

			if (isPartial) return new Text(theme.fg("muted", "searching…"), 0, 0);
			if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);

			const response = details?.response;
			const failures = details?.failures ?? [];
			const served = details?.timings?.filter(timing => timing.ok).at(-1);
			const count = response?.sources.length ?? 0;

			let head = theme.fg("success", `✓ ${response ? providerLabel(response.provider) : "?"}`);
			if (response?.authMode) head += theme.fg("dim", ` (${response.authMode})`);
			head += theme.fg("muted", ` · ${count} source${count === 1 ? "" : "s"}`);
			if (served) head += theme.fg("dim", ` · ${(served.ms / 1000).toFixed(1)}s`);
			if (failures.length > 0) {
				head += theme.fg("warning", ` · fell back after ${failures.map(failure => failure.provider).join(", ")}`);
			}

			if (!expanded) return new Text(head, 0, 0);

			const lines = [head];
			for (const [index, source] of (response?.sources ?? []).entries()) {
				lines.push(`${theme.fg("muted", `[${index + 1}]`)} ${theme.fg("text", source.title)}`);
				lines.push(theme.fg("dim", `    ${source.url}`));
				if (source.snippet) lines.push(theme.fg("dim", `    ${source.snippet.slice(0, 160)}`));
			}
			for (const failure of failures) {
				lines.push(theme.fg("warning", `  ${failure.label}: ${failure.reason}`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("websearch", {
		description: "Show the web search provider chain, or run a one-off query",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query || query === "status") {
				ctx.ui.notify(describeStatus(), "info");
				return;
			}
			if (query === "reload") {
				// Config file and environment are re-read on every call, so there is
				// nothing to invalidate; report the state the next search will use.
				ctx.ui.notify(`Web search config re-read from ${CONFIG_PATH}. No restart needed.`, "info");
				return;
			}
			const result = await executeSearch({ query });
			ctx.ui.notify(result.content[0].text, result.details.error ? "error" : "info");
		},
	});
}
