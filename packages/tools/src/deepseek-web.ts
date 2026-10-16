// The DeepSeek Search and Fetch backends for the web tools. Opt-in through
// LBB_WEB_SEARCH=deepseek / LBB_WEB_FETCH=deepseek. One attempt: no retry, and
// no fallback to the free path — a failure surfaces with the API's own code so
// the user decides. The guards run before any byte leaves the machine: the
// constant host through the network axis, the fetch target through the
// non-DNS half of the SSRF guard. Billing, for the record: each API costs
// ¥5 per 1000 successful requests, a request that fails or finds nothing is
// free, and each API is limited to 5 requests per second per account.
// Long-form design notes: docs/dev/tools.md

import type { ToolCallContext, ToolResult } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import {
	fetchWithTimeout,
	guardUrlWithoutDns,
	MAX_RESPONSE_BYTES,
	readCapped,
	refuseByNetworkPolicy,
	truncateWithMarker,
} from "./web-common.ts";

export const DEEPSEEK_HOST = "api.deepseek.com";
const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
/** How much of an error body or unreadable answer the message quotes. */
const ERROR_BODY_EXCERPT = 200;

export interface DeepSeekSearchHit {
	title: string;
	url: string;
	snippet: string;
	summary: string;
}

/** The Search request body. `count` does not affect billing either way. */
export function deepSeekSearchBody(input: { query: string; maxResults: number }): {
	query: string;
	count: number;
	need_content: boolean;
} {
	// `need_content` stays false: `summary` is the field the API documents for
	// the model, and the content of a promising hit is WebFetch's job.
	return { query: input.query, count: input.maxResults, need_content: false };
}

/** The Fetch request body. */
export function deepSeekFetchBody(url: string): { url: string } {
	return { url };
}

/**
 * Tolerant parse of a Search response: an entry without a non-empty `url` is
 * dropped, and a missing text field becomes the empty string.
 */
export function parseDeepSeekSearchResults(data: unknown): DeepSeekSearchHit[] {
	const results = (data as { results?: unknown } | null | undefined)?.results;
	if (!Array.isArray(results)) return [];
	const hits: DeepSeekSearchHit[] = [];
	for (const entry of results) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url : "";
		if (!url) continue;
		hits.push({
			title: typeof record.title === "string" ? record.title : "",
			url,
			snippet: typeof record.snippet === "string" ? record.snippet : "",
			summary: typeof record.summary === "string" ? record.summary : "",
		});
	}
	return hits;
}

/** `null` when the body carries no usable content. */
export function parseDeepSeekFetchResult(data: unknown): { title: string; content: string } | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	const content = typeof record.content === "string" ? record.content : "";
	if (!content.trim()) return null;
	return { title: typeof record.title === "string" ? record.title : "", content };
}

/**
 * The rendered search results: the numbered-block shape the free path prints,
 * with `summary` — the field the API documents for the model — as the body
 * and `snippet` as the fallback. Scores, site names, and dates are not
 * printed: the order already carries the ranking, and the rest is noise in
 * the model's context.
 */
export function renderDeepSeekSearchResults(hits: DeepSeekSearchHit[], maxResults: number): string {
	const lines = hits.slice(0, maxResults).map((hit, i) => {
		const body = hit.summary || hit.snippet;
		const head = `${i + 1}. ${hit.title}\n   ${hit.url}`;
		return body ? `${head}\n   ${body}` : head;
	});
	return lines.join("\n\n");
}

/** A per-status sentence appended after the API's own detail, or `null`. */
export function deepSeekErrorNote(tool: "search" | "fetch", status: number): string | null {
	switch (status) {
		case 401:
			return "DEEPSEEK_API_KEY is not accepted by DeepSeek.";
		case 402:
			return "The DeepSeek account has no balance; a request that fails is not billed.";
		case 403:
			return tool === "fetch" ? "DeepSeek refused this URL by its safety policy." : null;
		case 404:
			return tool === "fetch" ? "DeepSeek found no usable content at this URL." : null;
		case 408:
			return "DeepSeek's body timeout expired.";
		case 413:
			return "The request body was too large.";
		case 429:
			return "Rate limit reached: Search and Fetch each allow 5 requests per second per account.";
		case 500:
			return "DeepSeek reported an internal error.";
		case 504:
			return "DeepSeek's upstream timed out.";
		default:
			return null;
	}
}

/** The API's `code` and `message` out of an OpenAI-shaped error body. */
function parseErrorBody(body: string): { code?: string; message?: string } | null {
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return null;
	}
	const error = (data as { error?: unknown } | null | undefined)?.error;
	if (typeof error !== "object" || error === null) return null;
	const record = error as Record<string, unknown>;
	return {
		code: typeof record.code === "string" ? record.code : undefined,
		message: typeof record.message === "string" ? record.message : undefined,
	};
}

/** The message for a non-2xx answer: status, the API's code and detail, a note. */
export function deepSeekErrorText(input: {
	tool: "search" | "fetch";
	status: number;
	statusText: string;
	body: string;
}): string {
	const label = input.tool === "search" ? "Search" : "Fetch";
	const parsed = parseErrorBody(input.body);
	const code = parsed?.code ? ` (${parsed.code})` : "";
	const excerpt = input.body.replace(/\s+/g, " ").trim();
	const detail =
		parsed?.message || input.statusText || (excerpt ? excerpt.slice(0, ERROR_BODY_EXCERPT) : "") || "no error detail";
	const note = deepSeekErrorNote(input.tool, input.status);
	return `${label} failed: DeepSeek HTTP ${input.status}${code} — ${detail}${note ? ` ${note}` : ""}`;
}

/** The message for a 2xx answer whose body is not JSON. */
export function deepSeekUnreadableBody(tool: "search" | "fetch", body: string): string {
	const label = tool === "search" ? "Search" : "Fetch";
	const excerpt = body.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_EXCERPT);
	return `${label} failed: DeepSeek returned a body that is not JSON: ${excerpt}`;
}

/** The message when the switch is on but the key is not set. */
export function deepSeekMissingKeyText(tool: "search" | "fetch"): string {
	const [label, name, env] =
		tool === "search" ? ["Search", "WebSearch", "LBB_WEB_SEARCH"] : ["Fetch", "WebFetch", "LBB_WEB_FETCH"];
	return (
		`${label} failed: DEEPSEEK_API_KEY is not set. ${name} is using the DeepSeek backend (${env}=deepseek). ` +
		`Set the key in the shell environment or in settings.json under "env", or unset ${env}.`
	);
}

async function postDeepSeek(
	url: string,
	body: string,
	apiKey: string,
	userAgent: string,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"user-agent": userAgent,
			},
			body,
		},
		signal,
	);
}

export async function deepSeekSearch(
	input: { query: string; maxResults: number },
	ctx: ToolCallContext,
	apiKey: string | undefined,
): Promise<ToolResult> {
	const refusal = refuseByNetworkPolicy(DEEPSEEK_HOST, ctx.network);
	if (refusal) {
		return {
			content: [textContent(`Search blocked: ${refusal}. WebSearch sends the query to ${DEEPSEEK_HOST}.`)],
			isError: true,
		};
	}
	if (!apiKey) {
		return { content: [textContent(deepSeekMissingKeyText("search"))], isError: true };
	}
	let response: Response;
	try {
		response = await postDeepSeek(
			DEEPSEEK_SEARCH_URL,
			JSON.stringify(deepSeekSearchBody(input)),
			apiKey,
			"labunbun-code/0.1 (+websearch)",
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
	const body = await readCapped(response, MAX_RESPONSE_BYTES);
	if (!response.ok) {
		return {
			content: [
				textContent(
					deepSeekErrorText({
						tool: "search",
						status: response.status,
						statusText: response.statusText,
						body,
					}),
				),
			],
			isError: true,
		};
	}
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return { content: [textContent(deepSeekUnreadableBody("search", body))], isError: true };
	}
	const hits = parseDeepSeekSearchResults(data);
	if (hits.length === 0) {
		return { content: [textContent("No results found.")] };
	}
	return { content: [textContent(renderDeepSeekSearchResults(hits, input.maxResults))] };
}

export async function deepSeekFetch(
	input: { url: string; maxChars: number },
	ctx: ToolCallContext,
	apiKey: string | undefined,
): Promise<ToolResult> {
	// The whole point of the fetch happens on DeepSeek's side, so the local
	// guard runs only its non-DNS half: an internal literal or a name the
	// session's domain table refuses must not be handed to a third party, but
	// a local DNS answer would judge a resolution the fetch never uses.
	const targetRefusal = guardUrlWithoutDns(input.url, ctx.network);
	if (targetRefusal) {
		return { content: [textContent(`Fetch blocked: ${targetRefusal}`)], isError: true };
	}
	const refusal = refuseByNetworkPolicy(DEEPSEEK_HOST, ctx.network);
	if (refusal) {
		return {
			content: [textContent(`Fetch blocked: ${refusal}. WebFetch sends the URL to ${DEEPSEEK_HOST}.`)],
			isError: true,
		};
	}
	if (!apiKey) {
		return { content: [textContent(deepSeekMissingKeyText("fetch"))], isError: true };
	}
	let response: Response;
	try {
		response = await postDeepSeek(
			DEEPSEEK_FETCH_URL,
			JSON.stringify(deepSeekFetchBody(input.url)),
			apiKey,
			"labunbun-code/0.1 (+webfetch)",
			ctx.signal,
		);
	} catch (error) {
		if (ctx.signal.aborted) {
			return { content: [textContent("Tool execution aborted")], isError: true };
		}
		return {
			content: [textContent(`Fetch failed: ${error instanceof Error ? error.message : error}`)],
			isError: true,
		};
	}
	const body = await readCapped(response, MAX_RESPONSE_BYTES);
	if (!response.ok) {
		return {
			content: [
				textContent(
					deepSeekErrorText({
						tool: "fetch",
						status: response.status,
						statusText: response.statusText,
						body,
					}),
				),
			],
			isError: true,
		};
	}
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return { content: [textContent(deepSeekUnreadableBody("fetch", body))], isError: true };
	}
	const result = parseDeepSeekFetchResult(data);
	if (!result) {
		return { content: [textContent("(empty page)")] };
	}
	return {
		content: [textContent(`${input.url}\n\n${truncateWithMarker(result.content, input.maxChars)}`)],
	};
}
