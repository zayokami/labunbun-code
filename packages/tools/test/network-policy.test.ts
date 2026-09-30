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
	buildSandboxPolicy,
	decideNetworkRequest,
	describeNetworkPolicy,
	domainMatches,
	matchDomainRule,
	type NetworkConfinement,
	type NetworkDomainRule,
	needsNetworkProxy,
	networkConfinementReason,
	normalizeHost,
} from "@labunbun/agent";
import { networkConfinement, resolveSandboxExecution } from "../src/sandbox/index.ts";

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
	test("only claims the OS is holding the line when something is", () => {
		// The single most expensive sentence in this file is "the OS sandbox denies
		// outbound traffic to the command itself". A build that prints it where
		// nothing wraps the command has told the user their network is kernel-held
		// when the only thing holding it is a proxy a program can ignore. So: the
		// four non-native answers must each deny it, and the native one must be the
		// only one that claims it.
		const claims = (confinement: NetworkConfinement) =>
			describeNetworkPolicy("restricted", allow("example.com"), confinement);
		// The native case no longer says "still reaches nothing" — it says the
		// stronger and more useful thing, which is *why* a command reaches nothing.
		// Asserting the old phrase would have pinned the vaguer sentence.
		expect(claims("os-namespace")).toContain("denies the command every route off the machine, the proxy included");
		for (const confinement of [
			"no-os-backend",
			"backend-missing",
			"network-left-open",
			"filesystem-axis-off",
		] as const) {
			const text = claims(confinement);
			expect(text).toContain("proxy is the whole network boundary");
			expect(text).toContain("not subject to it");
			expect(text).not.toContain("still reaches nothing");
			expect(text).not.toContain("the proxy included");
		}
		// The reason differs across the four, and that difference is the point: one
		// is a gap in this build, one is a backend that is not installed, one is
		// what the sandbox must do to let allowed traffic out, and one is the mode
		// asking for no wrapper at all. Averaging them would leave the user with
		// something true and useless — unable to tell "this build cannot" from "you
		// asked it not to".
		expect(claims("no-os-backend")).toContain("ships no OS-level sandbox for this platform");
		expect(claims("backend-missing")).toContain("not installed here");
		expect(claims("network-left-open")).toContain("leaves the network open so allowed traffic");
		expect(claims("filesystem-axis-off")).toContain("sandbox axis is off");
	});

	test("an unrestricted network with no rules says nothing is interposed", () => {
		expect(describeNetworkPolicy("enabled", [], "os-namespace")).toContain("no proxy is interposed");
	});

	test("restricted with nothing allowed says nothing is reachable", () => {
		expect(describeNetworkPolicy("restricted", [], "os-namespace")).toContain("Nothing is reachable");
	});

	/**
	 * A restricted network under a native backend does not mean "this list is
	 * enforced on the shell". It means the shell has no route at all.
	 *
	 * The domain list is enforced at the proxy, and the proxy is reached over
	 * loopback — which `--unshare-net` and a `(deny default)` seatbelt profile both
	 * take away. So the list governs the web tools, which fetch in this process, and
	 * a command reaches nothing whether its host is listed or not. The old wording
	 * said "Only the 2 listed domains may be reached", which reads as a working
	 * allowlist and is false about every entry in it.
	 */
	test("the native case does not tell the user their allowlist governs a command", () => {
		const text = describeNetworkPolicy("restricted", allow("example.com", "registry.npmjs.org"), "os-namespace");
		expect(text).not.toContain("Only the 2 listed domains may be reached");
		expect(text).toContain("A command run through the shell reaches nothing at all here");
		expect(text).toContain("2 listed domains");
		expect(text).toContain("web tools may fetch");
		// And the four cases where the list *does* govern a command still say so,
		// so this is not a sentence that was simply softened everywhere.
		for (const confinement of [
			"no-os-backend",
			"backend-missing",
			"network-left-open",
			"filesystem-axis-off",
		] as const) {
			expect(describeNetworkPolicy("restricted", allow("example.com", "registry.npmjs.org"), confinement)).toContain(
				"Only the 2 listed domains may be reached",
			);
		}
	});

	/**
	 * The sentence is derived from what the translators actually emit.
	 *
	 * Every "honest reporting" claim in this repo is only worth something if the
	 * reporting and the argv come from the same fact. This is the test that ties
	 * them together: if someone implements the loopback narrowing the module header
	 * used to describe, this goes red and they have to revisit the sentence, and if
	 * someone drops `--unshare-net` without thinking, the control below is what says
	 * so.
	 */
	test("and that sentence is true of the argv a native backend is given", () => {
		const argvFor = (network: "restricted" | "enabled", platform: "darwin" | "linux") => {
			const resolution = resolveSandboxExecution({
				policy: buildSandboxPolicy({ sandbox: "workspace-write", workspace: "/w/repo", network }),
				command: ["/bin/sh", "-lc", "true"],
				platform,
				hasNativeBackend: true,
				exists: () => true,
			});
			if (resolution.kind !== "native") throw new Error(`expected native, got ${resolution.kind}`);
			return resolution.execution.argv.join(" ");
		};

		// Restricted: the shell has no route off the machine. Linux says so with a
		// namespace, macOS by emitting no network rule at all over `(deny default)`.
		expect(argvFor("restricted", "linux")).toContain("--unshare-net");
		const seatbelt = argvFor("restricted", "darwin");
		expect(seatbelt).not.toContain("(allow network-outbound)");
		// Neither backend lets the command reach the proxy on loopback, which is the
		// whole reason the sentence above says what it says. A future loopback
		// narrowing would put `127.0.0.1` in one of these and fail here.
		expect(argvFor("restricted", "linux")).not.toContain("127.0.0.1");
		expect(seatbelt).not.toContain("127.0.0.1");

		// The control: `enabled` leaves the network open, which is the other half of
		// what makes `network-left-open` the right answer for it.
		expect(argvFor("enabled", "linux")).not.toContain("--unshare-net");
		expect(argvFor("enabled", "darwin")).toContain("(allow network-outbound)");
	});
});

describe("networkConfinement", () => {
	test("an open network beats a working backend", () => {
		// A sandbox that denied outbound would deny the traffic the allowlist
		// exists to permit, so `enabled` forces the network open inside the
		// wrapper — and the proxy is then the whole boundary even on a Mac. The
		// reverse order here would print "still reaches nothing" about a machine
		// where the command's own socket is wide open.
		expect(networkConfinement("native", "workspace-write", "enabled")).toBe("network-left-open");
		expect(networkConfinement("native", "workspace-write", "restricted")).toBe("os-namespace");
	});

	test("danger-full-access beats a working backend too, which is the one no platform can see", () => {
		// The finding this file exists for. Every fact about a Mac says native, and
		// `resolveSandboxExecution` still returns `unconfined` because the mode asked
		// for no filesystem sandbox — so nothing is around the command and the
		// kernel holds nothing. Deriving the answer from the backend alone is the
		// mistake the fourth case exists to prevent.
		expect(networkConfinement("native", "danger-full-access", "restricted")).toBe("filesystem-axis-off");
		expect(
			describeNetworkPolicy(
				"restricted",
				allow("example.com"),
				networkConfinement("native", "danger-full-access", "restricted"),
			),
		).not.toContain("still reaches nothing");
	});

	test.each([
		[undefined, "no-os-backend"],
		["simulated", "no-os-backend"],
		["unavailable", "backend-missing"],
		["native", "os-namespace"],
	] as const)("backend %s with a confined filesystem", (backend, expected) => {
		// The one case the old signature got wrong by construction: `linux` with no
		// bubblewrap is `unavailable`, not `native`, and the sentence has to say so.
		expect(networkConfinement(backend, "workspace-write", "restricted")).toBe(expected);
	});

	test("an executor that reports no backend is read as the weakest", () => {
		// Same rule as `describeSandboxBackend`: not knowing is not evidence.
		expect(networkConfinement(undefined, "workspace-write", "restricted")).toBe("no-os-backend");
	});
});

describe("networkConfinementReason", () => {
	test("every proxy-only case has a reason that is about its own cause", () => {
		// Four cases, four different texts, and the text is the part a user acts
		// on — "install this" and "this build does not do that" are not the same
		// advice. A table with one generic sentence would pass every assertion in
		// the file above it and tell the user nothing here, so the distinguishing
		// phrase is what gets asserted.
		expect(networkConfinementReason("no-os-backend")).toContain("ships no OS-level sandbox");
		expect(networkConfinementReason("backend-missing")).toContain("not installed here");
		expect(networkConfinementReason("filesystem-axis-off")).toContain("sandbox axis is off");
		expect(networkConfinementReason("network-left-open")).toContain("leaves the network open");
		const reasons = new Set(
			(["no-os-backend", "backend-missing", "filesystem-axis-off", "network-left-open"] as const).map(
				networkConfinementReason,
			),
		);
		expect(reasons.size).toBe(4);
	});

	test("the reason appears in the sentence the two surfaces share", () => {
		// `/doctor` reads this function rather than restating the table, so this is
		// the tie between them: the caveat `describeNetworkPolicy` builds and the
		// sentence `/doctor` prints cannot drift apart unless this goes red.
		const confinement: NetworkConfinement = "backend-missing";
		expect(describeNetworkPolicy("restricted", allow("example.com"), confinement)).toContain(
			networkConfinementReason(confinement),
		);
	});
});
