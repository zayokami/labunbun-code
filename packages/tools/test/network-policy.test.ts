/**
 * The network domain rules, as a value.
 *
 * Pure functions, so every case runs on every machine — no platform skip
 * anywhere in this file, because which backend enforces a decision is a
 * property of the host and what the decision *is* is not.
 *
 * The negative cases carry the weight. A matcher that is one `endsWith` too
 * loose passes every positive case in this file and confines nothing, so each
 * near-miss below is a host a real allowlist would be written to exclude.
 */
import { describe, expect, test } from "bun:test";
import {
	decideNetworkRequest,
	describeNetworkPolicy,
	domainMatches,
	matchDomainRule,
	type NetworkDomainRule,
	needsNetworkProxy,
	normalizeHost,
} from "@labunbun/agent";

const allow = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "allow" as const }));

const deny = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "deny" as const }));

describe("normalizeHost", () => {
	test.each([
		["example.com", "example.com"],
		["EXAMPLE.COM", "example.com"],
		["example.com.", "example.com"],
		["example.com:443", "example.com"],
		["  example.com  ", "example.com"],
		["[::1]:8080", "::1"],
		["[::1]", "::1"],
		// An unbracketed IPv6 literal has several colons and must not be split
		// at the first one, which would turn `::1` into an empty host and then
		// into "no opinion".
		["::1", "::1"],
		["fe80::1%eth0", "fe80::1%eth0"],
	])("%s normalises to %s", (raw, expected) => {
		expect(normalizeHost(raw)).toBe(expected);
	});

	test.each(["", "   ", "[::1", "[", "]:80"])("%s is refused as malformed", (raw) => {
		// Not "no opinion": a host that will not parse is not one to be given
		// the benefit of the doubt, and `decideNetworkRequest` turns the empty
		// string into a refusal rather than an allow.
		expect(normalizeHost(raw)).toBe("");
		expect(decideNetworkRequest([], raw, "enabled")).toEqual({ allowed: false, reason: "malformed_host" });
	});
});

describe("domainMatches", () => {
	test.each([
		["example.com", "example.com", true],
		// The whole point of the exact spelling: it does not widen to subdomains,
		// and it does not match a host that merely ends with the same letters.
		["example.com", "api.example.com", false],
		["example.com", "evil-example.com", false],
		["example.com", "notexample.com", false],
		[".example.com", "example.com", true],
		[".example.com", "api.example.com", true],
		[".example.com", "a.b.example.com", true],
		// The boundary is the dot. Without it every suffix rule becomes a
		// substring rule and an allowlist stops being one.
		[".example.com", "evil-example.com", false],
		["*.example.com", "api.example.com", true],
		["*.example.com", "example.com", true],
		["*.example.com", "evil-example.com", false],
		["*", "anything.example", true],
		["", "example.com", false],
		["EXAMPLE.COM", "example.com", true],
	])("pattern %s against %s is %s", (pattern, host, expected) => {
		expect(domainMatches(pattern, host)).toBe(expected);
	});
});

describe("matchDomainRule", () => {
	test("deny wins whatever the order in the table", () => {
		// Both orderings are asserted because first-match would satisfy the
		// first and fail the second, which is what makes this the test that
		// catches a matcher reading top-down.
		expect(matchDomainRule([...allow("*"), ...deny("evil.com")], "evil.com")).toBe("deny");
		expect(matchDomainRule([...deny("evil.com"), ...allow("*")], "evil.com")).toBe("deny");
		expect(matchDomainRule([...allow("*"), ...deny("evil.com")], "good.com")).toBe("allow");
	});

	test("no rule covering the host is undefined, not a verdict", () => {
		// The distinction the mode's default hangs on: undefined means "apply
		// the default", and collapsing it to either verdict would make
		// `restricted` and `enabled` answer identically.
		expect(matchDomainRule(allow("example.com"), "other.com")).toBeUndefined();
	});
});

describe("decideNetworkRequest", () => {
	test("restricted permits only an explicit allow", () => {
		expect(decideNetworkRequest(allow("registry.npmjs.org"), "registry.npmjs.org", "restricted")).toEqual({
			allowed: true,
		});
		expect(decideNetworkRequest(allow("registry.npmjs.org"), "github.com", "restricted")).toEqual({
			allowed: false,
			reason: "no_matching_allow_rule",
		});
	});

	test("restricted with no rules reaches nothing", () => {
		// Fail-closed. The alternative — an empty table meaning "allow" — would
		// make turning the restriction on with no configuration a way to turn it
		// off, which is the one reading that cannot be defended.
		expect(decideNetworkRequest([], "example.com", "restricted")).toEqual({
			allowed: false,
			reason: "no_matching_allow_rule",
		});
	});

	test("enabled with no rules permits, which is today's behaviour", () => {
		expect(decideNetworkRequest([], "example.com", "enabled")).toEqual({ allowed: true });
	});

	test("a deny rule refuses even an allow that also matches", () => {
		expect(
			decideNetworkRequest(
				[...allow(".example.com"), ...deny("secrets.example.com")],
				"secrets.example.com",
				"enabled",
			),
		).toEqual({ allowed: false, reason: "domain_denied" });
		expect(
			decideNetworkRequest([...allow(".example.com"), ...deny("secrets.example.com")], "api.example.com", "enabled"),
		).toEqual({ allowed: true });
	});

	test("the host is matched as the client wrote it", () => {
		// A rule written for the canonical spelling must cover the spellings a
		// client actually sends, or the allowlist is a decoration.
		const rules = allow("example.com");
		for (const host of ["EXAMPLE.COM", "example.com:443", "example.com.", "example.com:80"]) {
			expect(decideNetworkRequest(rules, host, "restricted")).toEqual({ allowed: true });
		}
	});
});

describe("needsNetworkProxy", () => {
	test.each([
		["enabled" as const, [] as NetworkDomainRule[], false],
		["enabled" as const, allow("example.com"), true],
		["restricted" as const, [], true],
		["restricted" as const, allow("example.com"), true],
	])("network=%s with %d rules needs a proxy: %s", (mode, rules, expected) => {
		expect(needsNetworkProxy(mode, rules)).toBe(expected);
	});
});

describe("describeNetworkPolicy", () => {
	test("says the proxy is not the whole boundary only where that is true", () => {
		// The two sentences differ because the two platforms differ. A build that
		// ships the macOS sentence on Windows has told the user their network is
		// kernel-held when nothing here holds it.
		const onMac = describeNetworkPolicy("restricted", allow("example.com"), "darwin");
		const onWindows = describeNetworkPolicy("restricted", allow("example.com"), "win32");
		expect(onMac).toContain("OS sandbox holds the rest of the boundary");
		expect(onWindows).toContain("no OS-level network backend");
		expect(onWindows).toContain("not subject to it");
	});

	test("an unrestricted network with no rules says nothing is interposed", () => {
		expect(describeNetworkPolicy("enabled", [], "darwin")).toContain("no proxy is interposed");
	});

	test("restricted with nothing allowed says nothing is reachable", () => {
		expect(describeNetworkPolicy("restricted", [], "linux")).toContain("Nothing is reachable");
	});
});
