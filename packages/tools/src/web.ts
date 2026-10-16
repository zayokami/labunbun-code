// Web tools: WebFetch turns a URL into readable text, WebSearch searches the
// web. Both fetch in this process by default: WebFetch fetches the URL
// directly, and WebSearch scrapes the DuckDuckGo HTML endpoint, which needs no
// key. LBB_WEB_SEARCH=deepseek / LBB_WEB_FETCH=deepseek switch either tool to
// the paid, keyed DeepSeek Search/Fetch APIs. The tests cover the pure helpers.
// Long-form design notes: docs/dev/tools.md

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type AnyTool, buildTool, isBlockedAddress, type NetworkAxis } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import { DEEPSEEK_API_KEY_ENV, deepSeekFetch, deepSeekSearch } from "./deepseek-web.ts";
import {
	fetchWithTimeout,
	guardUrlWithoutDns,
	MAX_RESPONSE_BYTES,
	readCapped,
	refuseByNetworkPolicy,
	truncateWithMarker,
} from "./web-common.ts";

const MAX_CONTENT_CHARS = 40_000;

// Long-form design notes: docs/dev/tools.md
/** Where WebSearch goes, named so that the network axis has something to judge. */
const SEARCH_HOST = "html.duckduckgo.com";

/** The environment switches that move a web tool onto the paid DeepSeek APIs. */
export const LBB_WEB_SEARCH_ENV = "LBB_WEB_SEARCH";
export const LBB_WEB_FETCH_ENV = "LBB_WEB_FETCH";

export type WebSearchBackend = "duckduckgo" | "deepseek";
export type WebFetchBackend = "local" | "deepseek";

/**
 * Which backend each web tool uses. Exactly `deepseek` (trimmed, case
 * insensitive) turns the paid backend on; every other value — including a
 * misspelling — is the free default. The silence is deliberate: a typo must
 * not brick a session, and the tools have no startup channel to warn on.
 */
export function resolveWebBackends(
	env: { [name: string]: string | undefined },
	overrides: { search?: WebSearchBackend; fetch?: WebFetchBackend } = {},
): { search: WebSearchBackend; fetch: WebFetchBackend } {
	const isDeepSeek = (name: string) => env[name]?.trim().toLowerCase() === "deepseek";
	return {
		search: overrides.search ?? (isDeepSeek(LBB_WEB_SEARCH_ENV) ? "deepseek" : "duckduckgo"),
		fetch: overrides.fetch ?? (isDeepSeek(LBB_WEB_FETCH_ENV) ? "deepseek" : "local"),
	};
}

/** Strip HTML down to readable text: drop scripts/styles/tags, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Parse DuckDuckGo HTML results (link/result-snippet anchors). */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
	const out: SearchResult[] = [];
	const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

	const anchors: Array<{ url: string; title: string }> = [];
	for (;;) {
		const match = anchorRe.exec(html);
		if (!match) break;
		anchors.push({ url: decodeDdgUrl(match[1]), title: htmlToText(match[2]) });
	}
	const snippets: string[] = [];
	for (;;) {
		const match = snippetRe.exec(html);
		if (!match) break;
		snippets.push(htmlToText(match[1]));
	}
	for (let i = 0; i < anchors.length; i++) {
		out.push({
			title: anchors[i].title,
			url: anchors[i].url,
			snippet: snippets[i] ?? "",
		});
	}
	return out;
}

/** DuckDuckGo wraps URLs in a redirect (/l/?uddg=<encoded>) — unwrap them. */
function decodeDdgUrl(raw: string): string {
	try {
		const uddgMatch = raw.match(/[?&]uddg=([^&]+)/);
		if (uddgMatch) return decodeURIComponent(uddgMatch[1]);
		return raw.startsWith("//") ? `https:${raw}` : raw;
	} catch {
		return raw;
	}
}

// Long-form design notes: docs/dev/tools.md
/** The addresses a hostname stands for, at the moment of the check. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The real resolver. The only place in this module that touches DNS. */
export const resolveHostWithDns: HostResolver = async (hostname) => {
	const records = await lookup(hostname, { all: true });
	return records.map((record) => record.address);
};

// Long-form design notes: docs/dev/tools.md
/** Guard against SSRF: the non-DNS checks, then resolve the hostname and check every returned address. */
async function guardPublicUrl(
	rawUrl: string,
	network: NetworkAxis | undefined,
	resolveHost: HostResolver,
): Promise<string | null> {
	const withoutDns = guardUrlWithoutDns(rawUrl, network);
	if (withoutDns) return withoutDns;
	// The shared guard already parsed this URL and accepted its protocol, so
	// this second parse cannot throw and covers only the DNS half below.
	const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
	if (!isIP(hostname)) {
		let addresses: string[];
		try {
			addresses = await resolveHost(hostname);
		} catch {
			return `Could not resolve host: ${hostname}`;
		}
		// Zero addresses is a refusal, not a pass. The loop below is vacuously
		// satisfied by an empty list, so a resolver that answers "I know nothing
		// about this name" would otherwise turn the guard off for exactly the
		// names it cannot vouch for — and the failure is silent, because a name
		// that resolves to nothing private looks identical to a name that was
		// never checked.
		if (addresses.length === 0) return `Could not resolve host: ${hostname}`;
		for (const address of addresses) {
			if (isBlockedAddress(address)) return "Requests to private/internal addresses are not allowed";
		}
	}
	return null;
}

// Long-form design notes: docs/dev/tools.md
/** Fetch with an SSRF re-check on every hop. */
async function fetchGuarded(
	url: string,
	init: RequestInit,
	maxRedirects = 5,
	signal?: AbortSignal,
	network?: NetworkAxis,
	resolveHost: HostResolver = resolveHostWithDns,
): Promise<Response | { blocked: string }> {
	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const blockReason = await guardPublicUrl(current, network, resolveHost);
		if (blockReason) return { blocked: blockReason };
		const response = await fetchWithTimeout(current, { ...init, redirect: "manual" }, signal);
		const isRedirect = response.status >= 300 && response.status < 400;
		const location = response.headers.get("location");
		if (!isRedirect || !location) return response;
		current = new URL(location, current).toString();
	}
	return { blocked: "Too many redirects" };
}

export interface WebFetchOptions {
	/**
	 * How the SSRF guard turns a hostname into addresses. Defaults to the system
	 * resolver, which is the only correct answer in production; see
	 * {@link HostResolver} for why a test must not use it.
	 */
	resolveHost?: HostResolver;
	/** `deepseek` routes the fetch through the DeepSeek Fetch API; `local` (the default) fetches here. */
	backend?: WebFetchBackend;
}

export function createWebFetchTool(options: WebFetchOptions = {}): AnyTool {
	const backend = options.backend ?? "local";
	return buildTool({
		name: "WebFetch",
		// The description states the backend that is actually answering, so the
		// model is never told "fetched directly" about a request a third party
		// made on its behalf.
		description:
			backend === "deepseek"
				? "Fetches a URL via the DeepSeek Fetch API and returns its readable text content (Markdown, truncated). " +
					"Use for documentation pages, articles, and files served over HTTP."
				: "Fetches a URL and returns its readable text content (HTML stripped, truncated). " +
					"Use for documentation pages, articles, and files served over HTTP.",
		inputSchema: z.object({
			url: z.string().url().describe("Absolute HTTP(S) URL"),
			max_chars: z.number().int().positive().max(100_000).optional().describe("Content cap (default 40000)"),
		}),
		prompt:
			"- Prefer WebFetch over Bash curl for reading pages.\n" +
			"- For docs, fetch the most specific page rather than a landing page.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input, ctx) => {
			if (backend === "deepseek") {
				return deepSeekFetch(
					{ url: input.url, maxChars: input.max_chars ?? MAX_CONTENT_CHARS },
					ctx,
					process.env[DEEPSEEK_API_KEY_ENV],
				);
			}
			let response: Response;
			try {
				const result = await fetchGuarded(
					input.url,
					{ headers: { "user-agent": "labunbun-code/0.1 (+webfetch)" } },
					5,
					ctx.signal,
					ctx.network,
					options.resolveHost ?? resolveHostWithDns,
				);
				if ("blocked" in result) {
					return { content: [textContent(`Fetch blocked: ${result.blocked}`)], isError: true };
				}
				response = result;
			} catch (error) {
				if (ctx.signal.aborted) {
					return { content: [textContent("Tool execution aborted")], isError: true };
				}
				return {
					content: [textContent(`Fetch failed: ${error instanceof Error ? error.message : error}`)],
					isError: true,
				};
			}
			if (!response.ok) {
				return {
					content: [textContent(`HTTP ${response.status} ${response.statusText} for ${input.url}`)],
					isError: true,
				};
			}
			const contentType = response.headers.get("content-type") ?? "";
			const body = await readCapped(response, MAX_RESPONSE_BYTES);
			const text = contentType.includes("html") ? htmlToText(body) : body;
			const trimmed = truncateWithMarker(text, input.max_chars ?? MAX_CONTENT_CHARS);
			if (!trimmed.trim()) {
				return { content: [textContent("(empty page)")], isError: false };
			}
			return { content: [textContent(`${input.url}\n\n${trimmed}`)] };
		},
	});
}

export interface WebSearchOptions {
	/** `deepseek` routes the search through the DeepSeek Search API; `duckduckgo` (the default) scrapes the free HTML endpoint. */
	backend?: WebSearchBackend;
}

export function createWebSearchTool(options: WebSearchOptions = {}): AnyTool {
	const backend = options.backend ?? "duckduckgo";
	return buildTool({
		name: "WebSearch",
		description:
			backend === "deepseek"
				? "Web search via the DeepSeek Search API. Returns titles, URLs, and summaries. " +
					"Follow up with WebFetch to read a promising result."
				: "Web search via DuckDuckGo (no API key). Returns titles, URLs, and snippets. " +
					"Follow up with WebFetch to read a promising result.",
		inputSchema: z.object({
			// The DeepSeek API caps the query at 128 characters; the free path has
			// no documented cap, so its schema stays byte-identical.
			query:
				backend === "deepseek"
					? z.string().min(2).max(128).describe("The search query (up to 128 characters)")
					: z.string().min(2).describe("The search query"),
			max_results: z.number().int().min(1).max(10).optional().describe("Result cap (default 5)"),
		}),
		prompt:
			"- Search when a specific fact could have changed since your training data — " +
			"versions, prices, dates, current status — rather than answering from memory.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input, ctx) => {
			if (backend === "deepseek") {
				return deepSeekSearch(
					{ query: input.query, maxResults: input.max_results ?? 5 },
					ctx,
					process.env[DEEPSEEK_API_KEY_ENV],
				);
			}
			// The destination is a constant, so this reads like it cannot need a
			// check — and that is exactly why it needs one. The query is free text
			// the model chose, and it leaves the machine inside a URL to a third
			// party, which makes a search the shortest exfiltration channel in the
			// tool set: whatever is in the query reaches an outside host. A network
			// axis the search ignores is an axis with a hole shaped like "ask a
			// question".
			const refusal = refuseByNetworkPolicy(SEARCH_HOST, ctx.network);
			if (refusal) {
				return {
					content: [textContent(`Search blocked: ${refusal}. WebSearch sends the query to ${SEARCH_HOST}.`)],
					isError: true,
				};
			}
			let response: Response;
			try {
				response = await fetchWithTimeout(
					`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`,
					{ headers: { "user-agent": "labunbun-code/0.1 (+websearch)" } },
					ctx.signal,
				);
			} catch (error) {
				if (ctx.signal.aborted) {
					return { content: [textContent("Tool execution aborted")], isError: true };
				}
				return {
					content: [textContent(`Search failed: ${error instanceof Error ? error.message : error}`)],
					isError: true,
				};
			}
			if (!response.ok) {
				return {
					content: [textContent(`Search unavailable: HTTP ${response.status}. Try WebFetch on a known URL instead.`)],
					isError: true,
				};
			}
			const results = parseDuckDuckGoResults(await readCapped(response, MAX_RESPONSE_BYTES)).slice(
				0,
				input.max_results ?? 5,
			);
			if (results.length === 0) {
				return { content: [textContent("No results found.")] };
			}
			const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
			return { content: [textContent(lines.join("\n\n"))] };
		},
	});
}
