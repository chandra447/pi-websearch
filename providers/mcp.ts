/**
 * Minimal MCP client: JSON-RPC 2.0 `tools/call` over HTTP.
 *
 * Two keyless search backends (Parallel, Exa) are published as MCP servers
 * rather than REST endpoints, which makes them the only zero-credential
 * *structured* search available to an extension. No SDK, no transport
 * negotiation: a single POST, because that is all `tools/call` needs and every
 * heavier MCP abstraction would be dead code here.
 *
 * Responses arrive in two encodings depending on the server and on
 * `Accept` — plain JSON, or `text/event-stream` with a JSON payload per
 * `data:` line. Both are handled; Exa always uses SSE in practice.
 */

import { SearchProviderError } from "../types.ts";
import { classifyProviderHttpError, type FetchImpl } from "./utils.ts";

const USER_AGENT = "pi-websearch/1.0 (Pi coding agent extension)";

export interface McpContentBlock {
	type: string;
	text?: string;
}

export interface McpToolResult {
	structuredContent?: unknown;
	content?: McpContentBlock[];
	isError?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

interface RpcPayload {
	result?: unknown;
	error?: { message?: string };
}

/**
 * Extract the JSON-RPC payload from either a plain JSON body or an SSE stream.
 * For SSE, the last message carrying `result`/`error` wins — servers may emit
 * progress notifications first.
 */
function parseRpcPayload(body: string, provider: string): RpcPayload {
	const trimmed = body.trim();
	if (!trimmed) throw new SearchProviderError(provider, `${provider} MCP returned an empty body.`);

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new SearchProviderError(provider, `${provider} MCP returned malformed JSON.`);
		}
		if (Array.isArray(parsed)) {
			for (const entry of parsed) if (isRecord(entry)) return entry as RpcPayload;
			throw new SearchProviderError(provider, `${provider} MCP returned an empty JSON-RPC batch.`);
		}
		if (!isRecord(parsed)) throw new SearchProviderError(provider, `${provider} MCP returned a non-object payload.`);
		return parsed as RpcPayload;
	}

	let found: RpcPayload | undefined;
	for (const line of trimmed.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed: unknown = JSON.parse(data);
			if (isRecord(parsed) && ("result" in parsed || "error" in parsed)) found = parsed as RpcPayload;
		} catch {
			// Partial or non-JSON event; ignore rather than fail the whole call.
		}
	}
	if (!found) throw new SearchProviderError(provider, `${provider} MCP returned no JSON-RPC payload.`);
	return found;
}

/** Narrow an MCP result object to the fields the search path reads. */
function toMcpToolResult(value: unknown): McpToolResult {
	if (!isRecord(value)) return {};
	const content = Array.isArray(value.content)
		? value.content.filter(
				(item): item is McpContentBlock => isRecord(item) && typeof item.type === "string",
			)
		: undefined;
	return {
		...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
		...(content ? { content } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

export interface CallMcpToolOptions {
	url: string;
	provider: string;
	tool: string;
	args: Record<string, unknown>;
	fetchImpl: FetchImpl;
	signal: AbortSignal;
	headers?: Record<string, string>;
}

/** Invoke one MCP tool and return its result, or throw a provider error. */
export async function callMcpTool(options: CallMcpToolOptions): Promise<McpToolResult> {
	const { url, provider, tool, args, fetchImpl, signal, headers } = options;

	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": USER_AGENT,
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: tool, arguments: args },
		}),
		signal,
	});

	const body = await response.text();
	if (!response.ok) {
		throw (
			classifyProviderHttpError(provider, response.status, body) ??
			new SearchProviderError(provider, `${provider} MCP request failed (${response.status}).`, response.status)
		);
	}

	const payload = parseRpcPayload(body, provider);
	if (payload.error) {
		throw new SearchProviderError(provider, `${provider} MCP error: ${payload.error.message ?? "unknown error"}.`);
	}
	if ("result" in payload && typeof payload.result === "undefined") {
		throw new SearchProviderError(provider, `${provider} MCP returned a result-less response.`);
	}
	// Servers may wrap an error inside a successful JSON-RPC envelope.
	if (isRecord(payload.result) && "error" in payload.result && !("content" in payload.result)) {
		const inner = (payload.result as { error?: { message?: string } }).error;
		throw new SearchProviderError(provider, `${provider} MCP error: ${inner?.message ?? "unknown error"}.`);
	}

	const result = toMcpToolResult(payload.result);
	if (result.isError) {
		const message = result.content?.find((block) => block.type === "text" && block.text)?.text?.trim();
		throw new SearchProviderError(provider, message || `${provider} MCP reported a tool error.`);
	}
	return result;
}

/**
 * Pull a JSON object out of a tool result, preferring `structuredContent` and
 * falling back to JSON parsed from the first text block. Exa and Parallel both
 * return their payload as a JSON *string* inside `content[0].text`, so this is
 * the common path rather than an edge case.
 */
export function mcpJsonPayload(result: McpToolResult): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	for (const block of result.content ?? []) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		try {
			return JSON.parse(block.text);
		} catch {
			continue;
		}
	}
	return undefined;
}
