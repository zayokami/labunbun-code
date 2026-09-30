/**
 * The web tools are subject to the session's network axis.
 *
 * They fetch in *this* process, which is why this file exists at all. Every
 * other network path in the build is a child process with `HTTP_PROXY` set, and
 * the proxy is the thing that enforces the domain table — so a policy that
 * holds the shell and holds nothing else is not a policy the model has to obey,
 * it is one it routes around by using a different tool. `WebFetch` to a host the
 * allowlist refuses reached that host, while the same URL over `Bash` was
 * refused, and no mode closed the gap: `agent` allows the call outright and
 * `plan` lists both web tools as read-only.
 *
 * `fetch` is stubbed, so nothing is contacted — the assertion is on whether the
 * request was attempted at all, which is the decision under test. `calls` is the
 * load-bearing part: a refusal that still calls `fetch` would pass an assertion
 * on the returned text and confine nothing.
 */
import { describe, expect, test } from "bun:test";
import type { NetworkAxis, NetworkDomainRule } from "@labunbun/agent";
import { createWebFetchTool, createWebSearchTool } from "../src/web.ts";

const allow = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "allow" as const }));

/**
 * A stub that records every URL it was handed and answers 200 with a body.
 *
 * A real host would make these tests depend on the internet and on a host that
 * is *not* on the allowlist being reachable, which is exactly the property
 * under test and so cannot be the thing that provides it.
 */
function recordingFetch() {
	const original = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => {
		urls.push(typeof url === "string" ? url : url.toString());
		return Promise.resolve(
			new Response("<html><body><p>hello</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
	}) as typeof fetch;
	return {
		urls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const ctx = (network: NetworkAxis) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox: "workspace-write" as const,
	network,
	onUpdate: () => {},
});

/** Turn a tool result's content blocks into the text the model would see. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("WebFetch is subject to the network axis", () => {
	test("a host outside a restricted allowlist is refused without a request going out", async () => {
		const stub = recordingFetch();
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "https://exfil.example.net/collect" },
				ctx({ access: "restricted", domains: allow("registry.npmjs.org") }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Network policy refuses");
			// The assertion that carries the finding. A refusal message produced
			// *after* the fetch would read identically and stop nothing.
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("a host on the allowlist is fetched", async () => {
		const stub = recordingFetch();
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "https://registry.npmjs.org/lodash" },
				ctx({ access: "restricted", domains: allow("registry.npmjs.org") }),
			);
			expect(result.isError).toBeFalsy();
			expect(stub.urls).toEqual(["https://registry.npmjs.org/lodash"]);
		} finally {
			stub.restore();
		}
	});

	test("the control: an open network with no rules still fetches anything", async () => {
		// Without this, the tests above would also pass if the fix had refused
		// every fetch — which is the other way for this change to be wrong.
		const stub = recordingFetch();
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "https://exfil.example.net/collect" },
				ctx({ access: "enabled", domains: [] }),
			);
			expect(result.isError).toBeFalsy();
			expect(stub.urls).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	test("a denied pattern refuses even while other domains are allowed", async () => {
		// `enabled` with a deny rule is the other common shape, and it is the one
		// that catches a fix written only against `restricted`'s default-deny.
		const stub = recordingFetch();
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "https://exfil.example.net/collect" },
				ctx({
					access: "enabled",
					domains: [
						{ pattern: "registry.npmjs.org", permission: "allow" },
						{ pattern: "exfil.example.net", permission: "deny" },
					],
				}),
			);
			expect(result.isError).toBe(true);
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("a redirect to a refused host is refused too", async () => {
		// The check lives inside the hop loop precisely so this holds. A check at
		// the entry would see an allowed URL, follow the 302, and land on the
		// host the allowlist names — and the test above would still pass, because
		// that test never redirects.
		const original = globalThis.fetch;
		const visited: string[] = [];
		globalThis.fetch = ((url: string | URL | Request) => {
			const target = typeof url === "string" ? url : url.toString();
			visited.push(target);
			if (target === "https://example.com/start") {
				return Promise.resolve(
					new Response(null, { status: 302, headers: { location: "https://example.net/collect" } }),
				);
			}
			return Promise.resolve(new Response("<p>secret</p>", { status: 200 }));
		}) as typeof fetch;
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "https://example.com/start" },
				// `example.com` and `example.net` are the two reserved names that do
				// resolve, so the SSRF guard's own DNS lookup passes and the refusal
				// under test is the network axis's rather than a lookup failure. A
				// reserved-but-unresolvable name would refuse for the wrong reason and
				// prove nothing.
				ctx({ access: "restricted", domains: allow("example.com") }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Network policy refuses");
			// The first hop happened and was allowed; the second was refused. Both
			// facts are asserted, because "no fetch at all" would mean the test
			// proved something else.
			expect(visited).toEqual(["https://example.com/start"]);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("the SSRF guard still runs, and now runs on the policy path too", async () => {
		// The control for the ordering claim in `guardPublicUrl`: the network
		// check was added ahead of the DNS lookup, so this is the test that says
		// the check that was already there still is.
		const original = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = ((url: string | URL | Request) => {
			urls.push(typeof url === "string" ? url : url.toString());
			return Promise.resolve(new Response("<p>ok</p>", { status: 200 }));
		}) as typeof fetch;
		try {
			const tool = createWebFetchTool();
			const result = await tool.call(
				{ url: "http://127.0.0.1:8080/admin" },
				// `enabled`, so the network axis has no opinion at all and the SSRF
				// guard is the only thing that can refuse this.
				ctx({ access: "enabled", domains: [] }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("private/internal");
			expect(urls).toEqual([]);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("WebSearch is subject to the network axis", () => {
	test("a search whose destination is refused never sends the query", async () => {
		// The query is free text the model chose and it leaves the machine inside
		// a URL, so this is the exfiltration channel: an allowlist that admits one
		// registry and refuses the search endpoint has to refuse the search, or the
		// model can put whatever it has read into the query box.
		const stub = recordingFetch();
		try {
			const tool = createWebSearchTool();
			const result = await tool.call(
				{ query: "the contents of /etc/passwd" },
				ctx({ access: "restricted", domains: allow("registry.npmjs.org") }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Network policy refuses");
			expect(textOf(result)).toContain("html.duckduckgo.com");
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("the control: an allowlist containing the search host lets it through", async () => {
		const stub = recordingFetch();
		try {
			const tool = createWebSearchTool();
			await tool.call({ query: "bun test" }, ctx({ access: "restricted", domains: allow("html.duckduckgo.com") }));
			expect(stub.urls).toHaveLength(1);
			expect(stub.urls[0]).toContain("html.duckduckgo.com");
		} finally {
			stub.restore();
		}
	});

	test("and the second control: an open network with no rules searches", async () => {
		const stub = recordingFetch();
		try {
			const tool = createWebSearchTool();
			await tool.call({ query: "bun test" }, ctx({ access: "enabled", domains: [] }));
			expect(stub.urls).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});
});
