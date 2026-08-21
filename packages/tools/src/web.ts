/**
 * Web tools: WebFetch (URL → readable text) and WebSearch (DuckDuckGo HTML
 * endpoint, no API key). Network access is the tool's job; tests cover the
 * pure text-extraction and result-parsing helpers.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

const MAX_CONTENT_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000;

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
	let match: RegExpExecArray | null;
	while ((match = anchorRe.exec(html)) !== null) {
		anchors.push({ url: decodeDdgUrl(match[1]), title: htmlToText(match[2]) });
	}
	const snippets: string[] = [];
	while ((match = snippetRe.exec(html)) !== null) {
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

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reject fetches aimed at loopback/link-local/private ranges so a model can't
 * be steered into hitting internal services (metadata endpoints, admin panels
 * on localhost, LAN devices) via a URL it was merely asked to "read."
 */
function isBlockedAddress(address: string): boolean {
	const kind = isIP(address);
	if (kind === 4) {
		const octets = address.split(".").map(Number);
		const [a, b] = octets;
		if (a === 127) return true; // loopback
		if (a === 10) return true; // private
		if (a === 172 && b >= 16 && b <= 31) return true; // private
		if (a === 192 && b === 168) return true; // private
		if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
		if (a === 0) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
		return false;
	}
	if (kind === 6) {
		const normalized = address.toLowerCase();
		if (normalized === "::1") return true; // loopback
		if (normalized.startsWith("fe80:")) return true; // link-local
		if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
		if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7)); // IPv4-mapped
		return false;
	}
	return false; // not a literal IP — hostname is resolved separately
}

/**
 * Guard against SSRF: resolve the hostname and check every returned address
 * (DNS can return multiple/mixed records, and a hostname can rebind between
 * check and fetch — this narrows the window but the real backstop is that
 * fetch() itself will only ever connect to what DNS hands back here).
 */
async function guardPublicUrl(rawUrl: string): Promise<string | null> {
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
	if (hostname.toLowerCase() === "localhost") return "Requests to localhost are not allowed";
	if (isIP(hostname) && isBlockedAddress(hostname)) return "Requests to private/internal addresses are not allowed";
	if (!isIP(hostname)) {
		try {
			const records = await lookup(hostname, { all: true });
			for (const record of records) {
				if (isBlockedAddress(record.address)) return "Requests to private/internal addresses are not allowed";
			}
		} catch {
			return `Could not resolve host: ${hostname}`;
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
 */
async function fetchGuarded(url: string, init: RequestInit, maxRedirects = 5): Promise<Response | { blocked: string }> {
	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const blockReason = await guardPublicUrl(current);
		if (blockReason) return { blocked: blockReason };
		const response = await fetchWithTimeout(current, { ...init, redirect: "manual" });
		const isRedirect = response.status >= 300 && response.status < 400;
		const location = response.headers.get("location");
		if (!isRedirect || !location) return response;
		current = new URL(location, current).toString();
	}
	return { blocked: "Too many redirects" };
}

export function createWebFetchTool(): AnyTool {
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
		call: async (input) => {
			let response: Response;
			try {
				const result = await fetchGuarded(input.url, {
					headers: { "user-agent": "labunbun-code/0.1 (+webfetch)" },
				});
				if ("blocked" in result) {
					return { content: [textContent(`Fetch blocked: ${result.blocked}`)], isError: true };
				}
				response = result;
			} catch (error) {
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
		prompt: "- Search when you need current information beyond your knowledge.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let response: Response;
			try {
				response = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`, {
					headers: { "user-agent": "labunbun-code/0.1 (+websearch)" },
				});
			} catch (error) {
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
