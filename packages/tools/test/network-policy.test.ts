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
	isBlockedAddress,
	isBlockedNetworkHost,
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

describe("an address has more spellings than a hostname does", () => {
	// The finding. A `deny` rule for `127.0.0.1` used to catch exactly one of the
	// thirteen below, because `domainMatches` reduced to `host === pattern` and
	// `normalizeHost` tidied case and brackets without ever touching the address.
	// Under `enabled` — the mode in which a table is the only thing between a
	// confined command and the network — the other twelve were permitted, and the
	// only way a user could tell was to notice a rule was absent from the list of
	// things it stopped.
	//
	// Asserted as a table over *destinations* rather than over the normaliser,
	// because the property worth protecting is not "these strings reduce" — it is
	// "a rule stops what it names". A test on `normalizeHost` alone would pass on
	// an implementation that canonicalised the host and not the pattern, which is
	// half a fix and looks identical from here.
	const LOOPBACK_SPELLINGS = [
		"127.0.0.1",
		"127.0.0.01",
		"127.1",
		"127.5.5.5",
		"2130706433",
		"0x7f000001",
		"0177.0.0.1",
		"0177.1",
		"0x7f.1",
		"::1",
		"[::1]",
		"0:0:0:0:0:0:0:1",
		"::ffff:127.0.0.1",
		"[::ffff:127.0.0.1]",
	];

	test.each(LOOPBACK_SPELLINGS)("a deny rule for 127.0.0.1 refuses %s", (host) => {
		expect(decideNetworkRequest(deny("127.0.0.1"), host, "enabled")).toEqual({
			allowed: false,
			reason: "domain_denied",
		});
	});

	test.each(LOOPBACK_SPELLINGS)("a deny rule for ::1 refuses %s too", (host) => {
		// The other direction, which canonicalisation alone does not give: `::1` and
		// `127.0.0.1` are two addresses rather than two spellings of one. Both reach
		// the loopback interface, so a rule naming either is naming where the
		// connection goes — see `sameIpAddress`.
		expect(decideNetworkRequest(deny("::1"), host, "enabled")).toEqual({
			allowed: false,
			reason: "domain_denied",
		});
	});

	test.each([
		"10.0.0.1",
		"10.0.0.01",
		"192.168.1.1",
		"172.16.0.1",
		"169.254.169.254",
		"8.8.8.8",
		"::ffff:10.0.0.1",
		"fd00::1",
		"fe80::1",
		"2001:db8::1",
		"2001:0db8:0000:0000:0000:0000:0000:0001",
		"registry.npmjs.org",
	])("a deny rule for loopback does NOT reach %s", (host) => {
		// The other half, and the one that keeps the first from being satisfied by a
		// matcher that refuses everything. Loopback is the only range where the
		// families merge: `10.0.0.1` and `fd00::1` are not interchangeable, and a
		// deny that covered both would be covering addresses nobody named.
		expect(decideNetworkRequest(deny("127.0.0.1"), host, "enabled")).toEqual({ allowed: true });
	});

	describe("the reserved name is loopback, and knowing that costs no lookup", () => {
		// This table used to assert the opposite, on the reasoning that where a *name*
		// points is the resolver's business. Measured, that cost exactly the thing it
		// was meant to protect: with `allow *` and `deny 127.0.0.1` in force, every
		// loopback spelling was refused and `localhost` was permitted — the spelling a
		// user is most likely to actually type. RFC 6761 §6.3 reserves `localhost` and
		// its subdomains to loopback, so placing the name needs no DNS, and this must
		// not grow one: resolving would make a pure matcher impure and re-open the gap
		// that check-then-resolve leaves, where the name is judged once and connected
		// to on a second lookup.
		test.each(["localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost"])(
			"a deny rule for loopback reaches the reserved name %s",
			(host) => {
				expect(decideNetworkRequest(deny("127.0.0.1"), host, "enabled")).toEqual({
					allowed: false,
					reason: "domain_denied",
				});
			},
		);

		// The direction that matters most, and the one the table above cannot see: a
		// broad allow must not become a way round a deny the user wrote. `allow *` is
		// what a real config carries, and under it the default is allow — so without
		// this, everything above would also pass on a matcher that merged the families
		// only in the one mode where a deny was already the answer.
		test("an allow-* rule does not reopen loopback that a deny closed", () => {
			const rules: NetworkDomainRule[] = [
				{ pattern: "*", permission: "allow" },
				{ pattern: "127.0.0.1", permission: "deny" },
			];
			expect(decideNetworkRequest(rules, "127.0.0.1", "restricted").allowed).toBe(false);
			expect(decideNetworkRequest(rules, "localhost", "restricted").allowed).toBe(false);

			// The control, and it earns its place: this harness can tell a deny from an
			// allow at all. An earlier version of this work asserted the two lines above
			// under `restricted` with no allow rule present, where *everything* is denied
			// — so it read as proof while measuring nothing.
			const control: NetworkDomainRule[] = [
				{ pattern: "*", permission: "allow" },
				{ pattern: "evil.example", permission: "deny" },
			];
			expect(decideNetworkRequest(control, "evil.example", "restricted").allowed).toBe(false);
			expect(decideNetworkRequest(control, "good.example", "restricted").allowed).toBe(true);
		});
	});

	describe("one blocklist, reached from both halves of the repo", () => {
		// Moved out of `web.ts` into this package. The copy that was there unwrapped
		// `::ffff:` into its dotted tail, which answers for `::ffff:127.0.0.1` and not
		// for `::ffff:7f00:1` — the same address in the spelling the canonicaliser
		// produces. A comment here claimed the two halves agreed while measurement said
		// the `web.ts` one answered false for the hex form.
		test.each([
			"127.0.0.1",
			"::1",
			// Uncompressed loopback: only the fully-compressed `::1` used to match.
			"0:0:0:0:0:0:0:1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"fe80::1",
			"fd00::1",
			// The mapped forms, both spellings. The hex ones are what the moved copy
			// missed and are the reason the table is pinned at all.
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:a00:1",
			"::ffff:c0a8:101",
			"::ffff:a9fe:a9fe",
			"0:0:0:0:0:ffff:7f00:1",
		])("isBlockedAddress refuses %s", (address) => {
			expect(isBlockedAddress(address)).toBe(true);
		});

		test.each(["8.8.8.8", "2001:db8::1", "203.0.113.10"])(
			"isBlockedAddress does not refuse the public address %s",
			(address) => {
				expect(isBlockedAddress(address)).toBe(false);
			},
		);

		test("isBlockedAddress answers about addresses only, and says no to a name", () => {
			// A name is not blocked by a table, it is *resolved* by the caller and every
			// address that comes back is passed through here. `localhost` is refused by
			// rule one layer up instead, because its placement is a property of the name.
			// Asserting both keeps the two questions from drifting into one wrong answer.
			expect(isBlockedAddress("localhost")).toBe(false);
			expect(isBlockedAddress("example.com")).toBe(false);
		});
	});

	/**
	 * The IPv6 half of the table, which was four string prefixes where it should
	 * have been four ranges.
	 *
	 * `startsWith("fe80:")` reads as "block link-local" and blocks a sixteenth of
	 * it: `fe80::/10` runs through `febf`, and `fe81::1` to `febf::1` — seven of
	 * the sixteen blocks — came back unblocked. Every row below was measured on
	 * this box against the code as it stood before the change, not reasoned about.
	 */
	describe("an IPv6 range is a range, not a spelling", () => {
		const withFirstHextet = (hextet: number): string => `${hextet.toString(16)}::1`;
		const from = (low: number, high: number): number[] => {
			const out: number[] = [];
			for (let hextet = low; hextet <= high; hextet++) out.push(hextet);
			return out;
		};

		test.each(from(0xfe80, 0xfebf))("refuses the link-local block %s (fe80::/10)", (hextet) => {
			expect(isBlockedAddress(withFirstHextet(hextet))).toBe(true);
		});

		// The row that was broken, named one by one. A range walk above would still
		// pass if the mask were narrowed back to a /16, but only if it were narrowed
		// to exactly this one; these are the spellings a caller actually receives.
		test.each(["fe81::1", "fe90::1", "fea0::1", "feb0::1", "febf::1"])(
			'refuses %s, which startsWith("fe80:") did not cover',
			(address) => {
				expect(isBlockedAddress(address)).toBe(true);
			},
		);

		test.each(from(0xfc00, 0xfdff))("refuses the unique-local block %s (fc00::/7)", (hextet) => {
			expect(isBlockedAddress(withFirstHextet(hextet))).toBe(true);
		});

		test.each(from(0xfec0, 0xfeff))("refuses the site-local block %s (fec0::/10)", (hextet) => {
			expect(isBlockedAddress(withFirstHextet(hextet))).toBe(true);
		});

		test("the blocks on either side of fe80::/10 stay reachable, or the mask is too wide", () => {
			// `fe7f` is the last block below the range and `ff00` is multicast. A mask
			// widened to /9 would take `fe00` and `fe01` with it, and a mask widened to
			// /8 would take every global unicast address this build must be able to
			// reach. Both boundaries are asserted, because a range test that only
			// checks the inside cannot tell a correct mask from a large one.
			expect(isBlockedAddress("fe7f::1")).toBe(false);
			expect(isBlockedAddress("fe00::1")).toBe(false);
			expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
			expect(isBlockedAddress("2001:db8::1")).toBe(false);
		});

		test("0000::/8 is refused whole, which is what puts :: and ::1 in it", () => {
			// RFC 4291 §2.6.2 reserves the /8 for the source of a request that has
			// not chosen a source, so nothing legitimate is a destination there. Both
			// loopback spellings are inside it, which is why neither needs its own line
			// in the table any more.
			expect(isBlockedAddress("::")).toBe(true);
			expect(isBlockedAddress("::1")).toBe(true);
			expect(isBlockedAddress("::127.0.0.1")).toBe(true);
			expect(isBlockedAddress("::7f00:1")).toBe(true);
		});

		test("multicast is not on the list, and that is a decision rather than an omission", () => {
			// Asserted so the exclusion is visible: every caller in this build reaches
			// its destination over TCP, where a multicast group is not a destination,
			// so refusing it would stop nothing and read as coverage. A caller that
			// opens a UDP socket needs `ff00::/8` here and has to add it deliberately.
			expect(isBlockedAddress("ff02::1")).toBe(false);
		});
	});

	/**
	 * The three IPv6 prefixes that carry an IPv4 address inside them.
	 *
	 * The first is the one that was already here. The other two are routes to an
	 * IPv4 *destination*, which is what the table above refuses — so on a host with
	 * a NAT64 translator, `64:ff9b::a9fe:a9fe` is the cloud metadata address and
	 * `2002:7f00:1::` is loopback. All six rows below answered `false` before this
	 * change, measured rather than argued.
	 */
	describe("an IPv6 literal can carry an IPv4 destination, and then it is one", () => {
		test.each([
			// IPv4-mapped, RFC 4291 §2.5.5.2. Five zero groups, then `ffff`.
			["::ffff:a9fe:a9fe", "mapped cloud metadata, hex spelling"],
			["::ffff:169.254.169.254", "mapped cloud metadata, dotted"],
			["::ffff:a00:1", "mapped 10.0.0.1, hex"],
			// NAT64 well-known prefix, RFC 6052 §3.1 — "the IPv4 address is encoded
			// in positions 96 to 127" — with `64:ff9b::192.0.2.33` as the example.
			["64:ff9b::a9fe:a9fe", "NAT64 carrying the metadata address"],
			["64:ff9b::a00:1", "NAT64 carrying 10.0.0.1"],
			["64:ff9b::ac10:1", "NAT64 carrying 172.16.0.1"],
			["64:ff9b::7f00:1", "NAT64 carrying 127.0.0.1"],
			// 6to4, RFC 3056 §2.1 — the address sits in groups one and two, not the
			// last two, and the RFC's own example is `2002:c001:0203::`.
			["2002:a9fe:a9fe::", "6to4 carrying the metadata address"],
			["2002:a00:1::", "6to4 carrying 10.0.0.1"],
			["2002:7f00:1::", "6to4 carrying 127.0.0.1"],
		])("refuses %s (%s)", (address) => {
			expect(isBlockedAddress(address)).toBe(true);
		});

		// The other direction, and the one that decides whether the rule is a filter
		// or a denial-of-service. A NAT64 or 6to4 address wrapping a *public* IPv4 is
		// a real destination on an IPv6-only network; refusing it would break the
		// networks this build is most often used on, to close a hole that is not
		// there for them.
		test.each([
			["::ffff:8.8.8.8", "mapped, the spelling that has to keep working"],
			["64:ff9b::8.8.8.8", "NAT64 carrying a public resolver"],
			["64:ff9b::c000:221", "the RFC 6052 example, 192.0.2.33"],
			["2002:808:808::", "6to4 carrying 8.8.8.8"],
			["2002:c001:203::", "the RFC 3056 example, 192.1.2.3"],
		])("does not refuse %s (%s)", (address) => {
			expect(isBlockedAddress(address)).toBe(false);
		});

		test("the socket-facing entry point refuses the bracketed form a CONNECT client sends", () => {
			// `normalizeHost` has to strip the brackets and the port before the range
			// table sees anything, or the table is reading `[64:ff9b::a9fe:a9fe]:443`
			// and finding neither the prefix nor the address.
			expect(normalizeHost("[64:ff9b::a9fe:a9fe]:443")).toBe("64:ff9b::a9fe:a9fe");
			expect(isBlockedNetworkHost("[64:ff9b::a9fe:a9fe]:443")).toBe(true);
			expect(isBlockedNetworkHost("[2002:7f00:1::]:443")).toBe(true);
		});

		test("a NAT64 prefix that is not the well-known one is not decoded, and says so", () => {
			// RFC 6052 §2.1 moves the IPv4 to a different offset for every prefix
			// length but 96 and marks it with a reserved `u` octet. Those are not
			// covered, which is a real gap rather than a hypothetical one, and the
			// point of this test is that the gap is a decision on the record: if a
			// network-specific prefix is ever decoded, this goes red and has to be
			// rewritten rather than quietly becoming true.
			expect(isBlockedAddress("2001:db8:122:344::a9fe:a9fe")).toBe(false);
		});
	});

	describe("isBlockedNetworkHost, the one the socket-facing callers use", () => {
		/**
		 * The whole reason this function exists is that it answers a different
		 * question from the one above it. `isBlockedAddress` takes something that
		 * has already been resolved; a proxy reads a hostname off a socket, and a
		 * hostname that is never resolved here is relayed to whatever `/etc/hosts`
		 * says. So the two are asserted against each other rather than only
		 * against a list of right answers — a change that made them agree by
		 * making the new one stop covering names would pass a table of answers.
		 */
		test.each([
			["localhost", "the name itself"],
			["LOCALHOST", "the same name as a socket spells it"],
			["LocalHost", "mixed case"],
			["foo.localhost", "a subdomain of it, which the name layer covers too"],
			// Below: the same rows as the address table, to show the new function
			// is a superset rather than a replacement.
			["127.0.0.1", "an address"],
			["[::1]", "an address in the brackets a URL carries"],
			["169.254.169.254", "link-local, which is cloud metadata"],
			["10.0.0.1", "private"],
			["0.0.0.0", "the unspecified address"],
		])("refuses %s (%s)", (host) => {
			expect(isBlockedNetworkHost(host)).toBe(true);
		});

		test.each(["8.8.8.8", "example.com", "2001:db8::1", "[2001:db8::1]:8080", "not a host"])(
			"does not refuse %s",
			(host) => {
				expect(isBlockedNetworkHost(host)).toBe(false);
			},
		);

		test("the two functions disagree about exactly the names, and the row is the disagreement", () => {
			// Read as a pair: the left column is what the address table answers and
			// the right is what the host-level function answers for the same input.
			// Every row is a case where using the wrong one is a hole.
			expect([
				[isBlockedAddress("localhost"), isBlockedNetworkHost("localhost")],
				[isBlockedAddress("LOCALHOST"), isBlockedNetworkHost("LOCALHOST")],
				[isBlockedAddress("foo.localhost"), isBlockedNetworkHost("foo.localhost")],
				[isBlockedAddress("127.0.0.1"), isBlockedNetworkHost("127.0.0.1")],
			]).toEqual([
				[false, true],
				[false, true],
				[false, true],
				[true, true],
			]);
		});

		test("the bracket form is not hypothetical — it is what URL parsing produces", () => {
			// `new URL("http://[::1]:8080/").hostname` returns the literal with its
			// brackets, so a caller that skipped normalisation would hand
			// `isBlockedAddress` a string its range table cannot read.
			expect(new URL("http://[::1]:8080/").hostname).toBe("[::1]");
			expect(isBlockedNetworkHost(new URL("http://[::1]:8080/").hostname)).toBe(true);
		});

		test("a host that will not normalise is not reported as a blocked address", () => {
			// It is refused — by the rule engine, as `malformed_host`. Answering
			// true here would point at the wrong of the two, and the two travel in
			// the same header.
			expect(isBlockedNetworkHost("not a host")).toBe(false);
			expect(isBlockedNetworkHost("")).toBe(false);
			expect(isBlockedNetworkHost("[bad")).toBe(false);
		});
	});

	test.each([
		// IPv4, five spellings of one address. Measured against WHATWG parsing
		// rather than written from memory — `2130706433` and `0177.1` are the two
		// most surprising and the two most likely to be wrong.
		["2130706433", "127.0.0.1"],
		["127.1", "127.0.0.1"],
		["0x7f000001", "127.0.0.1"],
		["0177.0.0.1", "127.0.0.1"],
		["127.0.0.01", "127.0.0.1"],
		["0x7f.1", "127.0.0.1"],
		["0177.1", "127.0.0.1"],
		["127.0.0.1", "127.0.0.1"],
		["10.0.0.01", "10.0.0.1"],
		// IPv6, fully compressed. `::ffff:127.0.0.1` keeps the hex spelling rather
		// than collapsing to dotted — asserted because a change here would move the
		// embedded address the loopback check reads, silently and correctly-looking.
		["::1", "::1"],
		["[::1]", "::1"],
		["0:0:0:0:0:0:0:1", "::1"],
		["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
		["::ffff:127.0.0.1", "::ffff:7f00:1"],
		["FE80::1", "fe80::1"],
	])("normalizeHost reduces %s to %s", (raw, expected) => {
		// Direct, and deliberately *not* only through `decideNetworkRequest`. A
		// mutation run showed that once the loopback merge exists, every loopback
		// table entry above passes whether or not `normalizeHost` canonicalises at
		// all — `sameIpAddress` reduces both sides itself. So the loopback table
		// alone leaves the normaliser's own contract unpinned, and this is where it
		// is pinned.
		expect(normalizeHost(raw)).toBe(expected);
	});

	test("a deny rule written in a non-canonical spelling still matches a canonical host", () => {
		// The pattern side of the same fix. Canonicalising only the host would mean
		// `[::1]` stopped matching `::1` — the rule written by a user stops working
		// the moment they write it a second way, which is the same defect with the
		// sign flipped.
		expect(domainMatches("[::1]", "::1")).toBe(true);
		expect(domainMatches("0:0:0:0:0:0:0:1", "::1")).toBe(true);
		expect(domainMatches("2130706433", "127.0.0.1")).toBe(true);
		expect(domainMatches("127.1", "127.0.0.1")).toBe(true);
		expect(domainMatches("0177.0.0.1", "127.0.0.1")).toBe(true);
	});

	test("…including for an address outside loopback, where nothing else covers it", () => {
		// Written after a mutation driver showed the four assertions above passing
		// against code with the pattern's own `normalizeHost` call replaced by a
		// bare `toLowerCase`. Every loopback spelling they use is also reachable
		// through the loopback merge, so the whole table was satisfied by a second
		// mechanism and was testing the merge twice.
		//
		// The gap is a *non-loopback* address in a non-canonical spelling, because
		// that is the only shape where the two mechanisms can disagree: loopback
		// collapses `2001:0db8::1` to `2001:db8::1` on both sides either way, and
		// nothing merges it into anything else.
		expect(domainMatches("2001:0db8::1", "2001:db8::1")).toBe(true);
		expect(domainMatches("2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1")).toBe(true);
		expect(domainMatches("FE80::1", "fe80::1")).toBe(true);
		// And the reason that direction matters: it is what makes a *deny* on a
		// private IPv6 address stop working when the user writes it the long way.
		expect(decideNetworkRequest(deny("2001:0db8::1"), "2001:db8::1", "enabled")).toEqual({
			allowed: false,
			reason: "domain_denied",
		});
		// The control: the two are genuinely different addresses, so the merge must
		// not have grown to cover them.
		expect(domainMatches("2001:db8::1", "2001:db8::2")).toBe(false);
	});

	test("normalisation is idempotent, which is what makes it safe to apply twice", () => {
		// `decideNetworkRequest` normalises the host and `domainMatches` normalises
		// the pattern, so both sides of a comparison go through it. If reduction had
		// a fixed point that moved, the second application would produce a
		// comparison against a string neither side holds.
		for (const host of [...LOOPBACK_SPELLINGS, "example.com", "2001:db8::1", "fd00::1"]) {
			const once = normalizeHost(host);
			expect(normalizeHost(once), `${host} -> ${once} -> ${normalizeHost(once)}`).toBe(once);
		}
	});

	test("a hostname that merely looks numeric is still a hostname", () => {
		// The over-reduction, stated as the test it deserves. Every reduction here
		// is "ask a URL parser whether this is an address"; the failure mode of that
		// question being asked carelessly is turning a real name into a loopback one,
		// which would be an outage rather than a hole — and just as invisible.
		for (const host of ["0x7f.example.com", "127.example.com", "2130706433.example.com"]) {
			expect(normalizeHost(host), host).toBe(host);
			expect(decideNetworkRequest(deny("127.0.0.1"), host, "enabled")).toEqual({ allowed: true });
		}
	});

	test("the suffix patterns still behave, because the address path bypasses them", () => {
		// `domainMatches` now normalises the pattern, and the two suffix spellings
		// branch *before* that. This is the control: without it, a change to the
		// branch order would turn every `.example.com` rule into an address question
		// and these would quietly stop matching.
		expect(domainMatches("*.example.com", "api.example.com")).toBe(true);
		expect(domainMatches(".example.com", "example.com")).toBe(true);
		expect(domainMatches("example.com", "api.example.com")).toBe(false);
		expect(domainMatches("*", "2130706433")).toBe(true);
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
	 * The allowlist says which domains, not which ports.
	 *
	 * `decideNetworkRequest` takes a host and `normalizeHost` strips any `:port`, so
	 * a rule cannot tell one port from another — allowing a domain allows it on every
	 * port. That is the intended model, not a bug, but "may be reached" on its own
	 * reads like a host allowlist tight enough to pin a service's port. This test
	 * pins the disclosure so a future reword that drops it is a deliberate act.
	 */
	test("the allowlist sentence says it names domains, not ports", () => {
		const text = describeNetworkPolicy("restricted", allow("example.com", "registry.npmjs.org"), "no-os-backend");
		expect(text).toContain("on any port");
		expect(text).toContain("the list names domains, not ports");
		// And the property it discloses is real: the decision function is port-blind,
		// so the sentence is describing the code rather than softening it.
		expect(decideNetworkRequest(allow("example.com", "registry.npmjs.org"), "example.com", "restricted").allowed).toBe(
			true,
		);
		expect(
			decideNetworkRequest(allow("example.com", "registry.npmjs.org"), "example.com:22", "restricted").allowed,
		).toBe(true);
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
		// The container backend lands with the weakest for a measured reason
		// rather than a cautious one: the resolver's container branch is
		// reachable only with an `enabled` axis, because the proxy that
		// enforces `restricted` listens on loopback and a container child
		// cannot reach it — so the command being asked about resolved to
		// `simulated` and runs on the proxy. Reading `os-namespace` here would
		// describe a kernel denial the command never got, which is the
		// over-claim direction: a user told the OS denies every route while
		// their proxy-routed command is wide open.
		["appcontainer", "no-os-backend"],
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
