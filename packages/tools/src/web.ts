/**
 * Web tools: WebFetch (URL → readable text) and WebSearch (DuckDuckGo HTML
 * endpoint, no API key). Network access is the tool's job; tests cover the
 * pure text-extraction and result-parsing helpers.
 *
 * Both are subject to the session's network axis. That is not an addition, it
 * is the whole reason the axis exists: these two fetch in *this* process, so
 * `HTTP_PROXY` is not in the path and the proxy cannot hold them — which left
 * a single tool call reaching any public host while the same host over `Bash`
 * was refused by the axis. A network policy that one built-in tool walks
 * around is not a policy, it is a suggestion with a shell.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
	type AnyTool,
	buildTool,
	decideNetworkRequest,
	isBlockedAddress,
	type NetworkAxis,
	normalizeHost,
} from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

const MAX_CONTENT_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000;

/**
 * Where WebSearch goes. Named so the network axis has something to judge.
 *
 * A literal inlined into the fetch URL would make the check above it read as a
 * comparison against a constant that cannot vary — which is true, and is the
 * point: the host is fixed, so the decision can be made without a network round
 * trip, and the only variable in the request is the part that should be gated.
 */
const SEARCH_HOST = "html.duckduckgo.com";

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

async function fetchWithTimeout(url: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	// The run's own cancel has to reach the request too, or an interrupted turn
	// stays parked on the network until the timeout above expires.
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * The network axis's answer for `hostname`, as a refusal string or `null`.
 *
 * `decideNetworkRequest` is the same function the proxy calls, used here with
 * the same arguments, so there is one table and one decision rather than a
 * second matcher that could disagree with the first. `normalizeHost` first
 * because that is what the proxy applies to a CONNECT target, and the two
 * paths have to judge the same spelling of the same name the same way.
 */
function refuseByNetworkPolicy(hostname: string, network: NetworkAxis | undefined): string | null {
	if (!network) return null;
	const decision = decideNetworkRequest(network.domains, normalizeHost(hostname), network.access);
	if (decision.allowed) return null;
	return `Network policy refuses ${hostname} (${decision.reason})`;
}

/**
 * The addresses a hostname stands for, at the moment of the check.
 *
 * Injected rather than reached for directly, for the reason `resolveSandboxExecution`
 * takes an `exists`: the one impure call in the guard is the one a test must be
 * able to state. A test that lets this reach a real resolver is asserting on the
 * DNS of the machine and of the moment — and it does so *quietly*, because a name
 * that resolves on a developer laptop and does not resolve in CI fails the test
 * for a reason that has nothing to do with the code under test. That is not
 * hypothetical: this file's own header says nothing is contacted, and the guard's
 * lookup was still reaching out, so the one test asserting the network was open
 * passed at home and failed everywhere else.
 */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The real resolver. The only place in this module that touches DNS. */
export const resolveHostWithDns: HostResolver = async (hostname) => {
	const records = await lookup(hostname, { all: true });
	return records.map((record) => record.address);
};

/**
 * Guard against SSRF: resolve the hostname and check every returned address.
 * DNS can return several records, mixed families among them, so every one is
 * checked rather than the first.
 *
 * **What this does not do, stated because the alternative reading is stronger.**
 * It does not pin the connection to the address it checked. `fetch()` resolves
 * the name a second time, so a name whose answer changes between this lookup and
 * that one is checked against one address and connected to another. This narrows
 * that window to the gap between two resolutions; it does not close it. Closing
 * it means connecting to the resolved address while presenting the original
 * `Host`/SNI, which needs a MITM CA and an attribution frame to keep the two
 * apart — a trade this build has declined and documented at the top of
 * `proxy.ts`, so the honest sentence here is the narrow one rather than a claim
 * about the backstop.
 *
 * A lookup that fails is a refusal rather than a pass: not knowing where a name
 * points is not evidence that it points somewhere public, and the fail-closed
 * reading is the only one a URL the model chose can be given.
 *
 * The network axis is checked first and on the same pass, for two reasons. It
 * is cheaper — no DNS lookup — and it is the user's declared intent, so there
 * is no reason to resolve a name before finding out it was never allowed.
 */
async function guardPublicUrl(
	rawUrl: string,
	network: NetworkAxis | undefined,
	resolveHost: HostResolver,
): Promise<string | null> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return "Invalid URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `Unsupported protocol: ${url.protocol}`;
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const policyRefusal = refuseByNetworkPolicy(hostname, network);
	if (policyRefusal) return policyRefusal;
	if (hostname.toLowerCase() === "localhost") return "Requests to localhost are not allowed";
	if (isIP(hostname) && isBlockedAddress(hostname)) return "Requests to private/internal addresses are not allowed";
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

/** Read a response body up to a byte cap, aborting the stream once exceeded. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch with SSRF re-validation on every hop. `redirect: "manual"` stops the
 * runtime from silently following a redirect to a blocked address after the
 * initial URL passed the check — a public URL can 302 to a private one.
 *
 * The network axis rides on the same hop loop rather than being checked once
 * at the entry, which is the only placement that covers it: a public URL the
 * axis allows can 302 to a host it does not, and a check outside this loop
 * would be a check of the URL the model typed rather than of every host the
 * fetch actually visits.
 */
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
}

export function createWebFetchTool(options: WebFetchOptions = {}): AnyTool {
	return buildTool({
		name: "WebFetch",
		description:
			"Fetches a URL and returns its readable text content (HTML stripped, truncated). " +
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
			const cap = input.max_chars ?? MAX_CONTENT_CHARS;
			const trimmed = text.length > cap ? `${text.slice(0, cap)}\n\n[truncated ${text.length - cap} chars]` : text;
			if (!trimmed.trim()) {
				return { content: [textContent("(empty page)")], isError: false };
			}
			return { content: [textContent(`${input.url}\n\n${trimmed}`)] };
		},
	});
}

export function createWebSearchTool(): AnyTool {
	return buildTool({
		name: "WebSearch",
		description:
			"Web search via DuckDuckGo (no API key). Returns titles, URLs, and snippets. " +
			"Follow up with WebFetch to read a promising result.",
		inputSchema: z.object({
			query: z.string().min(2).describe("The search query"),
			max_results: z.number().int().min(1).max(10).optional().describe("Result cap (default 5)"),
		}),
		prompt:
			"- Search when a specific fact could have changed since your training data — " +
			"versions, prices, dates, current status — rather than answering from memory.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input, ctx) => {
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
