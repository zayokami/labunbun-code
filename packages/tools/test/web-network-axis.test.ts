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
 *
 * **The resolver is stubbed too, and that is not belt-and-braces.** Stubbing
 * `fetch` was not enough to keep the network out: `guardPublicUrl` resolves the
 * hostname itself, so every test here was also asserting on live DNS. The one
 * that noticed was the control — it fetches a name that exists nowhere, which
 * resolved on the machine it was written on and did not resolve on CI, so the
 * test passed at home and failed in all three jobs on every push. A test whose
 * verdict depends on a resolver is a test about the resolver.
 *
 * There is deliberately no test here that scans this file for a bare
 * `createWebFetchTool()` call. It was written, and it failed on its own text —
 * the scanner matches the pattern inside its own source — so the property it was
 * meant to protect turned out to have no cheap automated guard. Every fetch
 * below passes a stub resolver by inspection instead, and the guard on the
 * production side is the source assertion in `production still uses the real
 * resolver`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NetworkAxis, NetworkDomainRule } from "@labunbun/agent";
import { createWebFetchTool, createWebSearchTool, type HostResolver } from "../src/web.ts";

const allow = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "allow" as const }));

/**
 * A resolver that answers for any name, and records what it was asked.
 *
 * The default answer is a public address, so a test only has to say something
 * when the *destination* is the thing under test. `throws` is the other half of
 * the contract the real resolver has: a name that does not resolve is a refusal,
 * and a stub that always succeeds cannot tell a fail-closed guard from a
 * permissive one.
 */
function stubResolver(addresses: Record<string, string[]> = {}): HostResolver & { asked: string[] } {
	const asked: string[] = [];
	const resolve = async (hostname: string): Promise<string[]> => {
		asked.push(hostname);
		const answer = addresses[hostname];
		if (answer === undefined) return ["93.184.216.34"];
		if (answer.length === 0) throw new Error(`no such host: ${hostname}`);
		return answer;
	};
	return Object.assign(resolve, { asked });
}

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
		const resolver = stubResolver();
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "https://exfil.example.net/collect" },
				ctx({ access: "restricted", domains: allow("registry.npmjs.org") }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Network policy refuses");
			// The assertion that carries the finding. A refusal message produced
			// *after* the fetch would read identically and stop nothing. The
			// resolver is asserted too, because the refusal has to come from the
			// table rather than from a lookup that happens to fail — which is
			// precisely the confusion this file's last CI run had.
			expect(stub.urls).toEqual([]);
			expect(resolver.asked).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("a host on the allowlist is fetched", async () => {
		const stub = recordingFetch();
		const resolver = stubResolver();
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "https://registry.npmjs.org/lodash" },
				ctx({ access: "restricted", domains: allow("registry.npmjs.org") }),
			);
			expect(result.isError).toBeFalsy();
			expect(stub.urls).toEqual(["https://registry.npmjs.org/lodash"]);
			expect(resolver.asked).toEqual(["registry.npmjs.org"]);
		} finally {
			stub.restore();
		}
	});

	test("the control: an open network with no rules still fetches anything", async () => {
		// Without this, the tests above would also pass if the fix had refused
		// every fetch — which is the other way for this change to be wrong.
		//
		// This is also the test that caught the live-DNS dependency. It fetches
		// `exfil.example.net`, which resolves nowhere, so the guard's own lookup
		// refused it: green on a machine whose resolver answers, red on every CI
		// runner. The stub below is what makes the assertion about the network
		// axis rather than about `example.net`.
		const stub = recordingFetch();
		const resolver = stubResolver();
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "https://exfil.example.net/collect" },
				ctx({ access: "enabled", domains: [] }),
			);
			expect(result.isError).toBeFalsy();
			expect(stub.urls).toHaveLength(1);
			expect(resolver.asked).toEqual(["exfil.example.net"]);
		} finally {
			stub.restore();
		}
	});

	test("a denied pattern refuses even while other domains are allowed", async () => {
		// `enabled` with a deny rule is the other common shape, and it is the one
		// that catches a fix written only against `restricted`'s default-deny.
		const stub = recordingFetch();
		const resolver = stubResolver();
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
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
			expect(resolver.asked).toEqual([]);
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
			const resolver = stubResolver();
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "https://example.com/start" },
				// The resolver is stubbed to answer publicly, so the first hop passes
				// the SSRF guard and the refusal under test is the network axis's on
				// the second. This used to lean on `example.com` and `example.net`
				// being the two reserved names that *do* resolve — a real-network
				// dependency that happened to hold, and would have held only while
				// the DNS did.
				ctx({ access: "restricted", domains: allow("example.com") }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Network policy refuses");
			// The first hop happened and was allowed; the second was refused. Both
			// facts are asserted, because "no fetch at all" would mean the test
			// proved something else.
			expect(visited).toEqual(["https://example.com/start"]);
			// One lookup, for the first hop only. The second was refused before it
			// needed one, so a guard that resolved first and decided later would
			// show two.
			expect(resolver.asked).toEqual(["example.com"]);
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
			const resolver = stubResolver();
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "http://127.0.0.1:8080/admin" },
				// `enabled`, so the network axis has no opinion at all and the SSRF
				// guard is the only thing that can refuse this.
				ctx({ access: "enabled", domains: [] }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("private/internal");
			expect(urls).toEqual([]);
			// A literal needs no resolution, and this is the only assertion that
			// could tell the difference — the shape above it is the one that used to
			// depend on a live resolver.
			expect(resolver.asked).toEqual([]);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("a name that resolves to a private address is refused", async () => {
		// The reason the resolver is a seam. This is the guard's *other* half — the
		// one that has nothing to do with the literal above — and it could not be
		// written before without a real host that resolves to a private address,
		// which is not a thing anyone can arrange on demand. The cloud metadata
		// endpoint is the canonical target: a public name, a link-local answer.
		const stub = recordingFetch();
		const resolver = stubResolver({ "metadata.example": ["169.254.169.254"] });
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call(
				{ url: "http://metadata.example/latest/meta-data/" },
				ctx({ access: "enabled", domains: [] }),
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("private/internal");
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("a name that does not resolve is refused rather than fetched", async () => {
		// Fail-closed, and asserted rather than assumed: the alternative — treat an
		// unresolvable name as harmless and fetch it — is indistinguishable from
		// working code until the day the resolver starts answering.
		const stub = recordingFetch();
		const resolver = stubResolver({ "gone.example": [] });
		try {
			const tool = createWebFetchTool({ resolveHost: resolver });
			const result = await tool.call({ url: "https://gone.example/thing" }, ctx({ access: "enabled", domains: [] }));
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Could not resolve host");
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("a resolver that answers with nothing at all is a refusal, not a pass", async () => {
		// The hole the seam opens if nobody closes it. `guardPublicUrl` decides by
		// looping over the addresses it was handed, so an empty list satisfies
		// every iteration vacuously and the guard concludes "nothing private" about
		// a name it never checked. That is the shape of a security control that
		// can be switched off by making its input smaller.
		const stub = recordingFetch();
		const resolveHost: HostResolver = async () => [];
		try {
			const tool = createWebFetchTool({ resolveHost });
			const result = await tool.call({ url: "https://quiet.example/thing" }, ctx({ access: "enabled", domains: [] }));
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Could not resolve host");
			expect(stub.urls).toEqual([]);
		} finally {
			stub.restore();
		}
	});

	test("every private range the guard knows is refused by the same path", async () => {
		// Table over the resolver's answers rather than over the URLs, so the
		// property under test is the classification rather than the plumbing. The
		// public address is the control in the same table: without it, "refused"
		// would be satisfied by a guard that refuses everything, which is the
		// other way for this to be wrong and the one the SSRF test above cannot
		// see.
		const blocked = [
			"127.0.0.1",
			"10.0.0.5",
			"172.16.0.1",
			"172.31.255.254",
			"192.168.1.1",
			"169.254.169.254",
			"0.0.0.0",
			"100.64.0.1",
			"::1",
			"fe80::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		];
		for (const address of blocked) {
			const stub = recordingFetch();
			const resolver = stubResolver({ "probe.test": [address] });
			try {
				const tool = createWebFetchTool({ resolveHost: resolver });
				const result = await tool.call({ url: "https://probe.test/x" }, ctx({ access: "enabled", domains: [] }));
				expect(result.isError, `${address} must be refused`).toBe(true);
				expect(textOf(result)).toContain("private/internal");
				expect(stub.urls).toEqual([]);
			} finally {
				stub.restore();
			}
		}
		// The two neighbours of each boundary, because a range check that is one
		// octet too wide is a false alarm and one too narrow is a hole.
		for (const address of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "126.255.255.255", "128.0.0.1"]) {
			const stub = recordingFetch();
			const resolver = stubResolver({ "probe.test": [address] });
			try {
				const tool = createWebFetchTool({ resolveHost: resolver });
				const result = await tool.call({ url: "https://probe.test/x" }, ctx({ access: "enabled", domains: [] }));
				expect(result.isError, `${address} must be allowed`).toBeFalsy();
				expect(stub.urls).toEqual(["https://probe.test/x"]);
			} finally {
				stub.restore();
			}
		}
	});

	test("production still uses the real resolver, not the seam's absence", async () => {
		// The regression a test seam invites: "fixing" a flaky test by making the
		// default resolver a no-op would turn the SSRF guard off in every real
		// session while every test here stayed green, because every test here
		// passes its own. Asserted against the source rather than by making a
		// real query, so the check cannot itself become the DNS dependency it is
		// guarding against.
		const source = readFileSync(join(import.meta.dir, "..", "src", "web.ts"), "utf8");
		const defaults = source.match(/resolveHost: HostResolver = resolveHostWithDns/g) ?? [];
		expect(defaults).toHaveLength(1);
		expect(source).toContain("options.resolveHost ?? resolveHostWithDns");
		// Exactly three references and no fourth: the declaration, the one
		// parameter default, and the one fallback. A fourth would be a second way
		// for the resolver to be chosen, and which one a call got would depend on
		// which line its author happened to edit.
		expect(source.match(/resolveHostWithDns/g) ?? []).toHaveLength(3);
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
