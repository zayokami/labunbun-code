/**
 * The DeepSeek Search and Fetch backends behind LBB_WEB_SEARCH=deepseek and
 * LBB_WEB_FETCH=deepseek. The backend is opt-in and paid (¥5 per 1000
 * successful requests), so the tests pin three properties especially hard:
 * the switches parse exactly one way (any other value is the free default);
 * the guards run before any byte leaves — the constant host always, and the
 * fetch target through the non-DNS half of the guard, deliberately without a
 * local lookup; and a failure is one attempt with the API's own code in the
 * message — no retry, no silent fallback to the free path.
 *
 * `fetch` is stubbed, so nothing is contacted and nothing is billed. The
 * load-bearing assertion in the refusal rows is `stub.calls` being empty: a
 * refusal printed after the request would read identically and stop nothing.
 */
import { describe, expect, test } from "bun:test";
import type { NetworkAxis, NetworkDomainRule } from "@labunbun/agent";
import { z } from "zod";
import {
	DEEPSEEK_API_KEY_ENV,
	DEEPSEEK_HOST,
	deepSeekErrorNote,
	deepSeekErrorText,
	deepSeekFetchBody,
	deepSeekSearchBody,
	deepSeekUnreadableBody,
	parseDeepSeekFetchResult,
	parseDeepSeekSearchResults,
	renderDeepSeekSearchResults,
} from "../src/deepseek-web.ts";
import { createAllTools } from "../src/index.ts";
import { createWebFetchTool, createWebSearchTool, resolveWebBackends } from "../src/web.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

const allow = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "allow" as const }));
const enabled = (): NetworkAxis => ({ access: "enabled", domains: [] });

const ctxOf = (network: NetworkAxis, signal?: AbortSignal) => ({
	callId: "t1",
	signal: signal ?? new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write" as const,
	network,
	onUpdate: () => {},
});

/** Turn a tool result's content blocks into the text the model would see. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

/** A stub that records every call and answers from `handler`. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const href = typeof url === "string" ? url : url.toString();
		calls.push({ url: href, init });
		// Async so a throwing handler rejects like a real transport failure
		// instead of throwing synchronously, which fetch never does.
		return Promise.resolve().then(() => handler(href, init));
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

/** A fetch that behaves like the real one: rejects as soon as its signal aborts. */
function stallingFetch() {
	const original = globalThis.fetch;
	const state = { calls: 0 };
	globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
		state.calls++;
		return new Promise((_resolve, reject) => {
			const signal = init?.signal ?? undefined;
			const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			if (signal?.aborted) {
				fail();
				return;
			}
			signal?.addEventListener("abort", fail, { once: true });
		});
	}) as typeof fetch;
	return {
		state,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const jsonResponse = (data: unknown, status = 200, statusText = "") =>
	new Response(JSON.stringify(data), { status, statusText, headers: { "content-type": "application/json" } });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set (or delete) variables for one test, then put the environment back. */
async function withEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
	const before: Array<[string, string | undefined]> = Object.keys(values).map((key) => [key, process.env[key]]);
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("resolveWebBackends", () => {
	test("only the exact word deepseek turns a backend on; everything else is the free default", () => {
		expect(resolveWebBackends({})).toEqual({ search: "duckduckgo", fetch: "local" });
		expect(resolveWebBackends({ LBB_WEB_SEARCH: "", LBB_WEB_FETCH: "" })).toEqual({
			search: "duckduckgo",
			fetch: "local",
		});
		expect(resolveWebBackends({ LBB_WEB_SEARCH: " deepseek ", LBB_WEB_FETCH: "DeepSeek" })).toEqual({
			search: "deepseek",
			fetch: "deepseek",
		});
		expect(resolveWebBackends({ LBB_WEB_SEARCH: "duckduckgo", LBB_WEB_FETCH: "local" })).toEqual({
			search: "duckduckgo",
			fetch: "local",
		});
		// A misspelling degrades to the free path, silently and on purpose: the
		// tools have no startup channel, and a typo must not brick a session.
		expect(resolveWebBackends({ LBB_WEB_SEARCH: "yes", LBB_WEB_FETCH: "deepsek" })).toEqual({
			search: "duckduckgo",
			fetch: "local",
		});
	});

	test("an explicit override wins over the environment", () => {
		expect(resolveWebBackends({ LBB_WEB_SEARCH: "deepseek" }, { search: "duckduckgo" })).toEqual({
			search: "duckduckgo",
			fetch: "local",
		});
		expect(resolveWebBackends({}, { fetch: "deepseek" })).toEqual({ search: "duckduckgo", fetch: "deepseek" });
	});
});

describe("the request builders", () => {
	test("the search body is byte-exact; count carries max_results and billing ignores it", () => {
		expect(JSON.stringify(deepSeekSearchBody({ query: "bun test", maxResults: 3 }))).toBe(
			'{"query":"bun test","count":3,"need_content":false}',
		);
	});

	test("the fetch body is byte-exact", () => {
		expect(JSON.stringify(deepSeekFetchBody("https://example.com/a?b=c"))).toBe('{"url":"https://example.com/a?b=c"}');
	});
});

describe("the DeepSeek Search backend", () => {
	test("sends one POST with the exact body and headers, and reads the key from the environment", async () => {
		const stub = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const tool = createWebSearchTool({ backend: "deepseek" });
				const result = await tool.call({ query: "bun test", max_results: 3 }, ctxOf(enabled()));
				expect(stub.calls.length).toBe(1);
				const call = stub.calls[0];
				expect(call.url).toBe(SEARCH_URL);
				expect(call.init?.method).toBe("POST");
				expect(call.init?.body).toBe('{"query":"bun test","count":3,"need_content":false}');
				const headers = new Headers(call.init?.headers);
				expect(headers.get("authorization")).toBe("Bearer test-key");
				expect(headers.get("content-type")).toBe("application/json");
				expect(headers.get("user-agent")).toBe("labunbun-code/0.1 (+websearch)");
				expect(result.isError).toBeFalsy();
				expect(textOf(result)).toBe("No results found.");
			});
		} finally {
			stub.restore();
		}
	});

	test("a call without max_results asks for five", async () => {
		const stub = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(stub.calls[0].init?.body).toBe('{"query":"q x","count":5,"need_content":false}');
			});
		} finally {
			stub.restore();
		}
	});

	test("a restricted axis that refuses the host stops the search before any request", async () => {
		const stub = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const tool = createWebSearchTool({ backend: "deepseek" });
				const result = await tool.call(
					{ query: "something" },
					ctxOf({ access: "restricted", domains: allow("registry.npmjs.org") }),
				);
				expect(result.isError).toBe(true);
				expect(textOf(result)).toContain("Network policy refuses");
				expect(textOf(result)).toContain(DEEPSEEK_HOST);
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("the axis refusal comes before the key is even looked at", async () => {
		const stub = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: undefined }, async () => {
				const tool = createWebSearchTool({ backend: "deepseek" });
				const result = await tool.call(
					{ query: "something" },
					ctxOf({ access: "restricted", domains: allow("registry.npmjs.org") }),
				);
				expect(textOf(result)).toContain("Network policy refuses");
				expect(textOf(result)).not.toContain("DEEPSEEK_API_KEY is not set");
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("without the key the message names the variable, both supply paths, and the way back", async () => {
		const stub = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: undefined }, async () => {
				const result = await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe(
					"Search failed: DEEPSEEK_API_KEY is not set. WebSearch is using the DeepSeek backend " +
						'(LBB_WEB_SEARCH=deepseek). Set the key in the shell environment or in settings.json under "env", ' +
						"or unset LBB_WEB_SEARCH.",
				);
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("a 429 surfaces the code, the API's message, and the account-level limit", async () => {
		const stub = stubFetch(() =>
			jsonResponse(
				{
					error: {
						message: "Rate limit exceeded",
						type: "rate_limit_error",
						param: null,
						code: "rate_limit_exceeded",
					},
				},
				429,
				"Too Many Requests",
			),
		);
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(result.isError).toBe(true);
				const text = textOf(result);
				expect(text).toContain("HTTP 429");
				expect(text).toContain("(rate_limit_exceeded)");
				expect(text).toContain("Rate limit exceeded");
				expect(text).toContain("5 requests per second per account");
			});
		} finally {
			stub.restore();
		}
	});

	test("a 200 whose body is not JSON is an error that quotes the body", async () => {
		const stub = stubFetch(
			() => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(result.isError).toBe(true);
				expect(textOf(result)).toContain("not JSON");
				expect(textOf(result)).toContain("<html>nope</html>");
			});
		} finally {
			stub.restore();
		}
	});

	test("a failure is one attempt: no retry rides behind the switch", async () => {
		const stub = stubFetch(() =>
			jsonResponse(
				{ error: { message: "boom", type: "server_error", param: null, code: "server_error" } },
				500,
				"Internal Server Error",
			),
		);
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(result.isError).toBe(true);
				expect(stub.calls.length).toBe(1);
			});
		} finally {
			stub.restore();
		}
	});

	test("a transport throw is one attempt too, and keeps the free path's shape", async () => {
		const stub = stubFetch(() => {
			throw new Error("socket closed");
		});
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebSearchTool({ backend: "deepseek" }).call({ query: "q x" }, ctxOf(enabled()));
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe("Search failed: socket closed");
				expect(stub.calls.length).toBe(1);
			});
		} finally {
			stub.restore();
		}
	});
});

describe("the DeepSeek Fetch backend", () => {
	test("sends one POST with the exact body, and renders URL plus Markdown with no title line", async () => {
		const stub = stubFetch(() => jsonResponse({ title: "Example Domain", content: "# Example\n\nMarkdown body." }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/a?b=c" },
					ctxOf(enabled()),
				);
				expect(stub.calls.length).toBe(1);
				const call = stub.calls[0];
				expect(call.url).toBe(FETCH_URL);
				expect(call.init?.method).toBe("POST");
				expect(call.init?.body).toBe('{"url":"https://example.com/a?b=c"}');
				const headers = new Headers(call.init?.headers);
				expect(headers.get("authorization")).toBe("Bearer test-key");
				expect(headers.get("user-agent")).toBe("labunbun-code/0.1 (+webfetch)");
				// Byte-for-byte the local path's shape, so the two backends are
				// interchangeable for everything downstream.
				expect(textOf(result)).toBe("https://example.com/a?b=c\n\n# Example\n\nMarkdown body.");
			});
		} finally {
			stub.restore();
		}
	});

	test("a target outside a restricted allowlist is refused before the API is called", async () => {
		const stub = stubFetch(() => jsonResponse({ content: "x" }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://exfil.example.net/collect" },
					ctxOf({ access: "restricted", domains: allow("example.com") }),
				);
				expect(result.isError).toBe(true);
				expect(textOf(result)).toContain("Fetch blocked: Network policy refuses");
				expect(textOf(result)).toContain("exfil.example.net");
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("the API host itself is subject to the axis even when the target passes", async () => {
		const stub = stubFetch(() => jsonResponse({ content: "x" }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/page" },
					ctxOf({ access: "restricted", domains: allow("example.com") }),
				);
				expect(result.isError).toBe(true);
				expect(textOf(result)).toContain("Network policy refuses");
				expect(textOf(result)).toContain(DEEPSEEK_HOST);
				expect(textOf(result)).toContain("WebFetch sends the URL to");
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("literal private addresses and localhost never leave for DeepSeek", async () => {
		const stub = stubFetch(() => jsonResponse({ content: "x" }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const tool = createWebFetchTool({ backend: "deepseek" });
				const cases: Array<[string, string]> = [
					["http://127.0.0.1/x", "private/internal"],
					["http://localhost/x", "localhost"],
					["http://[::1]/x", "private/internal"],
					["http://169.254.169.254/latest/", "private/internal"],
				];
				for (const [url, marker] of cases) {
					const result = await tool.call({ url }, ctxOf(enabled()));
					expect(result.isError).toBe(true);
					expect(textOf(result)).toContain(marker);
				}
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});

	test("a private-looking NAME is still handed to DeepSeek: no local DNS for the target", async () => {
		// The fetch happens on DeepSeek's side, so a local lookup would judge a
		// resolution the fetch never uses. If someone adds a DNS step here (the
		// local path has one), this row fails loudly: internal.example resolves
		// nowhere, and a lookup would refuse it before the API ever sees it.
		const stub = stubFetch(() => jsonResponse({ content: "ok" }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "http://internal.example/" },
					ctxOf(enabled()),
				);
				expect(result.isError).toBeFalsy();
				expect(stub.calls.length).toBe(1);
				expect(stub.calls[0].url).toBe(FETCH_URL);
			});
		} finally {
			stub.restore();
		}
	});

	test("truncation matches the local path byte for byte", async () => {
		const content = "0123456789ABCDE"; // 15 chars; a cap of 10 leaves 5 behind the marker
		const stub = stubFetch(() => jsonResponse({ content }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/", max_chars: 10 },
					ctxOf(enabled()),
				);
				expect(textOf(result)).toBe("https://example.com/\n\n0123456789\n\n[truncated 5 chars]");
			});
		} finally {
			stub.restore();
		}
	});

	test("whitespace-only content is an empty page, not an error", async () => {
		const stub = stubFetch(() => jsonResponse({ title: "T", content: "  \n " }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/" },
					ctxOf(enabled()),
				);
				expect(result.isError).toBeFalsy();
				expect(textOf(result)).toBe("(empty page)");
			});
		} finally {
			stub.restore();
		}
	});

	test("without the key the message names the variable, both supply paths, and the way back", async () => {
		const stub = stubFetch(() => jsonResponse({ content: "x" }));
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: undefined }, async () => {
				const result = await createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/" },
					ctxOf(enabled()),
				);
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe(
					"Fetch failed: DEEPSEEK_API_KEY is not set. WebFetch is using the DeepSeek backend " +
						'(LBB_WEB_FETCH=deepseek). Set the key in the shell environment or in settings.json under "env", ' +
						"or unset LBB_WEB_FETCH.",
				);
				expect(stub.calls).toEqual([]);
			});
		} finally {
			stub.restore();
		}
	});
});

describe("the DeepSeek backends honour the run's abort signal", () => {
	test("WebSearch stops on abort instead of waiting out its timeout", async () => {
		const stub = stallingFetch();
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const controller = new AbortController();
				const pending = createWebSearchTool({ backend: "deepseek" }).call(
					{ query: "q x" },
					ctxOf(enabled(), controller.signal),
				);
				await delay(50);
				expect(stub.state.calls).toBe(1);
				controller.abort();
				const result = await pending;
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe("Tool execution aborted");
			});
		} finally {
			stub.restore();
		}
	}, 15_000);

	test("WebFetch stops on abort instead of waiting out its timeout", async () => {
		const stub = stallingFetch();
		try {
			await withEnv({ [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const controller = new AbortController();
				const pending = createWebFetchTool({ backend: "deepseek" }).call(
					{ url: "https://example.com/" },
					ctxOf(enabled(), controller.signal),
				);
				await delay(50);
				expect(stub.state.calls).toBe(1);
				controller.abort();
				const result = await pending;
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe("Tool execution aborted");
			});
		} finally {
			stub.restore();
		}
	}, 15_000);
});

describe("search rendering", () => {
	const full = {
		rerank_score: 2.9,
		title: "Bun releases",
		url: "https://bun.sh/blog",
		snippet: "snippet-body",
		summary: "summary-body",
		content: "",
		site_name: "SITE-SENTINEL",
		site_icon: "https://bun.sh/favicon.ico",
		date: "2026-05-05T05:05:05Z",
		authority: 4,
	};

	test("summary is the body the model reads; the snippet is only the fallback", () => {
		const hits = parseDeepSeekSearchResults({ results: [full] });
		expect(renderDeepSeekSearchResults(hits, 5)).toBe("1. Bun releases\n   https://bun.sh/blog\n   summary-body");
	});

	test("an empty summary falls back to the snippet", () => {
		const hits = parseDeepSeekSearchResults({ results: [{ ...full, summary: "" }] });
		expect(renderDeepSeekSearchResults(hits, 5)).toContain("snippet-body");
	});

	test("a hit with no body at all renders two lines", () => {
		const hits = parseDeepSeekSearchResults({ results: [{ ...full, summary: "", snippet: "" }] });
		expect(renderDeepSeekSearchResults(hits, 5)).toBe("1. Bun releases\n   https://bun.sh/blog");
	});

	test("scores, site names, and dates are not printed into the model's context", () => {
		const rendered = renderDeepSeekSearchResults(parseDeepSeekSearchResults({ results: [full] }), 5);
		expect(rendered).not.toContain("SITE-SENTINEL");
		expect(rendered).not.toContain("2026-05-05");
		expect(rendered).not.toContain("2.9");
	});

	test("the count is capped and entries without a URL are dropped", () => {
		const hits = parseDeepSeekSearchResults({
			results: [full, { ...full, title: "Two" }, { ...full, title: "Three" }, { title: "no url" }],
		});
		expect(hits.length).toBe(3);
		const rendered = renderDeepSeekSearchResults(hits, 2);
		expect(rendered).toContain("1. Bun releases");
		expect(rendered).toContain("2. Two");
		expect(rendered).not.toContain("Three");
	});

	test("a missing or malformed results field parses to nothing", () => {
		expect(parseDeepSeekSearchResults({})).toEqual([]);
		expect(parseDeepSeekSearchResults({ results: "nope" })).toEqual([]);
		expect(parseDeepSeekSearchResults(null)).toEqual([]);
	});

	test("a body with content parses; a missing or whitespace-only one is null", () => {
		expect(parseDeepSeekFetchResult({ title: "T", content: "body" })).toEqual({ title: "T", content: "body" });
		expect(parseDeepSeekFetchResult({ title: "T", content: "  \n " })).toBeNull();
		expect(parseDeepSeekFetchResult({})).toBeNull();
		expect(parseDeepSeekFetchResult(null)).toBeNull();
	});
});

describe("DeepSeek error text", () => {
	const errorBody = (code: string | null, message: string | null) =>
		JSON.stringify({ error: { message, type: "x", param: null, code } });

	test("every documented status gets its note, and an undocumented one gets none", () => {
		expect(deepSeekErrorNote("fetch", 401)).toContain("not accepted");
		expect(deepSeekErrorNote("search", 402)).toContain("no balance");
		expect(deepSeekErrorNote("fetch", 403)).toContain("safety policy");
		expect(deepSeekErrorNote("search", 403)).toBeNull();
		expect(deepSeekErrorNote("fetch", 404)).toContain("no usable content");
		expect(deepSeekErrorNote("search", 404)).toBeNull();
		expect(deepSeekErrorNote("search", 408)).toContain("timeout");
		expect(deepSeekErrorNote("search", 413)).toContain("too large");
		expect(deepSeekErrorNote("search", 429)).toContain("5 requests per second per account");
		expect(deepSeekErrorNote("search", 500)).toContain("internal error");
		expect(deepSeekErrorNote("search", 504)).toContain("upstream");
		expect(deepSeekErrorNote("search", 418)).toBeNull();
	});

	test("the status line carries the API's code and message", () => {
		const text = deepSeekErrorText({
			tool: "search",
			status: 429,
			statusText: "Too Many Requests",
			body: errorBody("rate_limit_exceeded", "Rate limit exceeded"),
		});
		expect(text).toBe(
			"Search failed: DeepSeek HTTP 429 (rate_limit_exceeded) — Rate limit exceeded " +
				"Rate limit reached: Search and Fetch each allow 5 requests per second per account.",
		);
	});

	test("a missing message falls back to the status text, then to a collapsed excerpt", () => {
		const noMessage = deepSeekErrorText({
			tool: "fetch",
			status: 500,
			statusText: "Internal Server Error",
			body: errorBody("server_error", null),
		});
		expect(noMessage).toContain("— Internal Server Error");
		const notJson = deepSeekErrorText({
			tool: "fetch",
			status: 502,
			statusText: "",
			body: "<html>\n  <body>gateway   exploded</body>\n</html>",
		});
		expect(notJson).toContain("HTTP 502");
		expect(notJson).toContain("— <html> <body>gateway exploded</body> </html>");
	});

	test("a very long detail is excerpted to 200 collapsed characters", () => {
		const long = "x".repeat(500);
		const text = deepSeekErrorText({ tool: "search", status: 400, statusText: "", body: long });
		expect(text).toContain("x".repeat(200));
		expect(text).not.toContain("x".repeat(201));
	});

	test("the unreadable-body message quotes the start of the body", () => {
		expect(deepSeekUnreadableBody("search", "<html>nope</html>")).toBe(
			"Search failed: DeepSeek returned a body that is not JSON: <html>nope</html>",
		);
	});
});

describe("createAllTools wiring", () => {
	test("LBB_WEB_SEARCH=deepseek moves WebSearch onto the API; unset keeps the DuckDuckGo path", async () => {
		const deep = stubFetch(() => jsonResponse({ results: [] }));
		try {
			await withEnv({ LBB_WEB_SEARCH: "deepseek", [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const search = createAllTools(process.cwd()).find((tool) => tool.name === "WebSearch");
				if (!search) throw new Error("WebSearch is not in the default tool set");
				const result = await search.call({ query: "bun test" }, ctxOf(enabled()));
				expect(deep.calls[0].url).toBe(SEARCH_URL);
				expect(deep.calls[0].init?.method).toBe("POST");
				expect(textOf(result)).toBe("No results found.");
			});
		} finally {
			deep.restore();
		}

		const free = stubFetch(
			() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		try {
			await withEnv({ LBB_WEB_SEARCH: undefined, LBB_WEB_FETCH: undefined }, async () => {
				const search = createAllTools(process.cwd()).find((tool) => tool.name === "WebSearch");
				if (!search) throw new Error("WebSearch is not in the default tool set");
				await search.call({ query: "bun test" }, ctxOf(enabled()));
				expect(free.calls[0].url).toBe("https://html.duckduckgo.com/html/?q=bun%20test");
			});
		} finally {
			free.restore();
		}
	});

	test("LBB_WEB_FETCH=deepseek moves WebFetch onto the API; unset fetches the URL here", async () => {
		const deep = stubFetch(() => jsonResponse({ title: "T", content: "api body" }));
		try {
			await withEnv({ LBB_WEB_FETCH: "deepseek", [DEEPSEEK_API_KEY_ENV]: "test-key" }, async () => {
				const fetchTool = createAllTools(process.cwd()).find((tool) => tool.name === "WebFetch");
				if (!fetchTool) throw new Error("WebFetch is not in the default tool set");
				const result = await fetchTool.call({ url: "https://example.com/a" }, ctxOf(enabled()));
				expect(deep.calls[0].url).toBe(FETCH_URL);
				expect(textOf(result)).toBe("https://example.com/a\n\napi body");
			});
		} finally {
			deep.restore();
		}

		const free = stubFetch(
			() => new Response("local body", { status: 200, headers: { "content-type": "text/plain" } }),
		);
		try {
			await withEnv({ LBB_WEB_SEARCH: undefined, LBB_WEB_FETCH: undefined }, async () => {
				const fetchTool = createAllTools(process.cwd()).find((tool) => tool.name === "WebFetch");
				if (!fetchTool) throw new Error("WebFetch is not in the default tool set");
				// Literal public address: the local guard resolves hostnames over
				// DNS, and a real lookup has no business in this file.
				const result = await fetchTool.call({ url: "http://93.184.216.34/" }, ctxOf(enabled()));
				expect(free.calls[0].url).toBe("http://93.184.216.34/");
				expect(textOf(result)).toBe("http://93.184.216.34/\n\nlocal body");
			});
		} finally {
			free.restore();
		}
	});

	test("a switch with no key still builds every tool; the error belongs to the call", async () => {
		await withEnv(
			{ LBB_WEB_SEARCH: "deepseek", LBB_WEB_FETCH: "deepseek", [DEEPSEEK_API_KEY_ENV]: undefined },
			async () => {
				const tools = createAllTools(process.cwd());
				expect(tools.some((tool) => tool.name === "WebSearch")).toBe(true);
				expect(tools.some((tool) => tool.name === "WebFetch")).toBe(true);
			},
		);
	});
});

describe("descriptions and schemas tell the truth about the backend", () => {
	test("the free defaults keep their wording, and the free schema keeps no query cap", () => {
		expect(createWebSearchTool().description).toContain("DuckDuckGo (no API key)");
		const schema = z.toJSONSchema(createWebSearchTool().inputSchema) as any;
		expect(schema.properties.query.maxLength).toBeUndefined();
	});

	test("the DeepSeek variants name the API, drop the 'no API key' claim, and cap the query at 128", () => {
		const search = createWebSearchTool({ backend: "deepseek" });
		expect(search.description).toContain("DeepSeek Search API");
		expect(search.description).not.toContain("no API key");
		expect(createWebFetchTool({ backend: "deepseek" }).description).toContain("DeepSeek Fetch API");
		const schema = z.toJSONSchema(search.inputSchema) as any;
		expect(schema.properties.query.maxLength).toBe(128);
	});

	test("the prompt keeps the world-keyed phrase in both variants", () => {
		for (const backend of ["duckduckgo", "deepseek"] as const) {
			const prompt = createWebSearchTool({ backend }).prompt ?? "";
			expect(prompt).toContain("could have changed since your training data");
			expect(prompt).not.toContain("beyond your knowledge");
		}
	});
});
