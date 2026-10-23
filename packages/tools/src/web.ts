// Web tools: WebFetch turns a URL into readable text, WebSearch searches the
// web. Both fetch in this process by default: WebFetch fetches the URL
// directly, and WebSearch scrapes the DuckDuckGo HTML endpoint, which needs no
// key. LBB_WEB_SEARCH=deepseek / LBB_WEB_FETCH=deepseek switch either tool to
// the paid, keyed DeepSeek Search/Fetch APIs. The tests cover the pure helpers.
// Long-form design notes: docs/dev/tools.md

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type AnyTool, buildTool, isBlockedAddress, type NetworkAxis } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import { DEEPSEEK_API_KEY_ENV, deepSeekFetch, deepSeekSearch } from "./deepseek-web.ts";
import {
	FETCH_TIMEOUT_MS,
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

/** The guard's answer: a refusal, or the checked addresses one hop may dial. */
type UrlVerdict = { blocked: string } | { addresses: string[] };

// Long-form design notes: docs/dev/tools.md
/** Guard against SSRF: the non-DNS checks, then resolve the hostname and check every returned address. */
async function guardPublicUrl(
	rawUrl: string,
	network: NetworkAxis | undefined,
	resolveHost: HostResolver,
): Promise<UrlVerdict> {
	const withoutDns = guardUrlWithoutDns(rawUrl, network);
	if (withoutDns) return { blocked: withoutDns };
	// The shared guard already parsed this URL and accepted its protocol, so
	// this second parse cannot throw and covers only the DNS half below.
	const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
	// A literal is its own answer, and the shared guard already judged it.
	if (isIP(hostname)) return { addresses: [hostname] };
	let addresses: string[];
	try {
		addresses = await resolveHost(hostname);
	} catch {
		return { blocked: `Could not resolve host: ${hostname}` };
	}
	// Zero addresses is a refusal, not a pass. The loop below is vacuously
	// satisfied by an empty list, so a resolver that answers "I know nothing
	// about this name" would otherwise turn the guard off for exactly the
	// names it cannot vouch for — and the failure is silent, because a name
	// that resolves to nothing private looks identical to a name that was
	// never checked.
	if (addresses.length === 0) return { blocked: `Could not resolve host: ${hostname}` };
	for (const address of addresses) {
		if (isBlockedAddress(address)) return { blocked: "Requests to private/internal addresses are not allowed" };
		// An answer that is not an address cannot be pinned, and
		// `isBlockedAddress` is false for a name. A resolver that answered
		// `localhost` would otherwise pass the loop and leave the next lookup
		// free to decide where the request goes.
		if (isIP(address) === 0) return { blocked: `Could not resolve host: ${hostname}` };
	}
	return { addresses };
}

/**
 * One hop to an address the guard has already vetted.
 *
 * The shape is `fetch`'s because that is what this replaces for the local
 * backend — same URL, same init, a `Response` back — with the one difference
 * that decides where the socket goes. Injectable so a test can watch a hop
 * without a network, and so the rebinding test can assert that the address
 * checked is the address handed to the transport.
 */
export type WebFetchTransport = (
	url: string,
	init: RequestInit,
	addresses: readonly string[],
	signal?: AbortSignal,
) => Promise<Response>;

/**
 * The response body under its content coding, decoded when every coding is one
 * this transport advertised.
 *
 * The old path was the global `fetch`, which both advertises `gzip, deflate,
 * br` and decodes them. A pinned hop talks to the origin itself, so the
 * advertising and the decoding are its job too; skipping both would hand a
 * compressed page to the HTML stripper. A coding outside the advertised set
 * stays encoded — the headers then still describe the bytes — rather than
 * being half-decoded.
 */
function decodeResponseBody(res: IncomingMessage): { stream: Readable; decoded: boolean } {
	const codings = String(res.headers["content-encoding"] ?? "")
		.split(",")
		.map((coding) => coding.trim().toLowerCase())
		.filter((coding) => coding !== "" && coding !== "identity");
	if (codings.length === 0) return { stream: res, decoded: false };
	const decoders: Transform[] = [];
	for (const coding of codings) {
		if (coding === "gzip" || coding === "x-gzip") decoders.push(createGunzip());
		else if (coding === "deflate") decoders.push(createInflate());
		else if (coding === "br") decoders.push(createBrotliDecompress());
		else return { stream: res, decoded: false };
	}
	let stream: Readable = res;
	// A body is encoded in list order, so it is decoded in reverse.
	for (const decoder of decoders.reverse()) stream = stream.pipe(decoder);
	return { stream, decoded: true };
}

/**
 * The production hop: HTTP(S) to the first vetted address, with TLS and the
 * `Host` header still naming the origin.
 *
 * `fetch` is not used because it offers no way to say which address to dial:
 * it resolves the hostname itself, and that second answer is exactly the one
 * the guard never saw. A literal in the client options leaves no lookup for
 * the HTTP stack to run.
 */
export const defaultWebFetchTransport: WebFetchTransport = async (url, init, addresses, signal) => {
	const target = new URL(url);
	const address = addresses[0];
	if (address === undefined) throw new Error("no vetted address to connect to");
	const secure = target.protocol === "https:";
	const hostname = target.hostname.replace(/^\[|\]$/g, "");
	const headers = new Headers(init.headers);
	// Without this the HTTP client would send the vetted literal as `Host`, and
	// a name-based virtual host would answer for the wrong origin or refuse the
	// request outright. A `Host` the caller set itself is preserved.
	if (!headers.has("host")) headers.set("host", target.host);
	// The codings the global `fetch` advertised, so a pinned hop sees the same
	// pages it used to; `decodeResponseBody` undoes them below.
	if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
	return await new Promise<Response>((resolve, reject) => {
		const onResponse = (res: IncomingMessage) => {
			const responseHeaders = new Headers();
			for (const [name, value] of Object.entries(res.headers)) {
				if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
				else if (value !== undefined) responseHeaders.set(name, value);
			}
			const status = res.statusCode ?? 502;
			// A null-body status cannot carry a stream — the `Response` constructor
			// throws for one — and it has no body by definition.
			let body: ReadableStream<Uint8Array> | null = null;
			if (!(init.method === "HEAD" || status === 204 || status === 304)) {
				const decoded = decodeResponseBody(res);
				// The body below is decoded, so the headers that describe the
				// encoded bytes would be lies on the synthesized `Response`.
				if (decoded.decoded) {
					responseHeaders.delete("content-encoding");
					responseHeaders.delete("content-length");
				}
				body = Readable.toWeb(decoded.stream) as unknown as ReadableStream<Uint8Array>;
			}
			resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }));
		};
		const requestOptions = {
			// The vetted literal: the HTTP client must not resolve the name a
			// second time, because the second answer is the one the guard never saw.
			host: address,
			port: target.port || (secure ? 443 : 80),
			method: init.method ?? "GET",
			path: `${target.pathname}${target.search}`,
			headers: Object.fromEntries(headers),
			// A certificate is verified against the origin's name, not the address
			// it currently resolves to; SNI has to say the same, or a name-based
			// virtual host serves the wrong site or no site.
			...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
			// No pooled connection: every hop is pinned to an address this request
			// vetted, and a reused socket would be a different request's.
			agent: false,
		};
		const req = secure ? httpsRequest(requestOptions, onResponse) : httpRequest(requestOptions, onResponse);
		req.on("error", reject);
		// The run's cancel and this request's deadline both arrive as an abort.
		// Destroying the request tears down the socket and errors any body stream
		// the caller may already be reading.
		const onAbort = () => req.destroy(new Error("The operation was aborted."));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		req.once("close", () => signal?.removeEventListener("abort", onAbort));
		const requestBody = init.body;
		if (typeof requestBody === "string" || requestBody instanceof Uint8Array) req.write(requestBody);
		else if (requestBody !== undefined && requestBody !== null) {
			req.destroy(new Error("unsupported request body for the pinned WebFetch transport"));
			return;
		}
		req.end();
	});
};

/** The transport call under the same deadline and run-cancel the other fetch paths use. */
async function fetchPinned(
	transport: WebFetchTransport,
	url: string,
	init: RequestInit,
	addresses: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	// A signal that aborted before this listener was attached never fires
	// "abort" again, so the already-aborted case is read first — the same shape
	// as `fetchWithTimeout`, for the same reason.
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await transport(url, init, addresses, controller.signal);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

// Long-form design notes: docs/dev/tools.md
/** Fetch with an SSRF re-check on every hop, each hop dialling only an address that check vetted. */
async function fetchGuarded(
	url: string,
	init: RequestInit,
	maxRedirects = 5,
	signal?: AbortSignal,
	network?: NetworkAxis,
	resolveHost: HostResolver = resolveHostWithDns,
	transport: WebFetchTransport = defaultWebFetchTransport,
): Promise<Response | { blocked: string }> {
	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const verdict = await guardPublicUrl(current, network, resolveHost);
		if ("blocked" in verdict) return { blocked: verdict.blocked };
		const response = await fetchPinned(transport, current, init, verdict.addresses, signal);
		const isRedirect = response.status >= 300 && response.status < 400;
		const location = response.headers.get("location");
		if (!isRedirect || !location) return response;
		// The redirect body is not the page and is never read; cancelling it
		// releases the socket the pinned connection still holds.
		await response.body?.cancel().catch(() => {});
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
	/**
	 * The single hop to an address the guard vetted. Injectable so a test can
	 * see which address a request dials, and prove a second resolver answer
	 * cannot change it; the default dials the checked literal itself.
	 */
	transport?: WebFetchTransport;
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
					options.transport ?? defaultWebFetchTransport,
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
				// The error page is not read; cancelling the body releases the
				// pinned connection instead of leaving it to the collector.
				await response.body?.cancel().catch(() => {});
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
