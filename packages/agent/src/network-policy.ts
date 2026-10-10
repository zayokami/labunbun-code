// Which hosts a confined command may reach, decided as a value. The proxy that
// enforces it is the only part that touches a socket, so the decision is pure.
// Long-form design notes: docs/dev/sandbox.md
import { isIP } from "node:net";

// Long-form design notes: docs/dev/sandbox.md
/** Per-pattern verdicts, as a value rather than a bare type. */
export const NETWORK_DOMAIN_PERMISSIONS = ["allow", "deny"] as const;

/** Per-pattern verdict. */
export type NetworkDomainPermission = (typeof NETWORK_DOMAIN_PERMISSIONS)[number];

export interface NetworkDomainRule {
	// Long-form design notes: docs/dev/sandbox.md
	/** A host pattern: `*`, `example.com` exactly, or the two suffix spellings. */
	pattern: string;
	permission: NetworkDomainPermission;
}

// Long-form design notes: docs/dev/sandbox.md
/** Why a request was refused. Carried so the proxy can answer in words. */
export type NetworkDenialReason = "domain_denied" | "no_matching_allow_rule" | "malformed_host" | "blocked_address";

export interface NetworkDecision {
	allowed: boolean;
	/** Present only when refused; the machine-readable half of the answer. */
	reason?: NetworkDenialReason;
}

// Long-form design notes: docs/dev/sandbox.md
/** The one spelling of an IP literal that everything else reduces to. */
function canonicalIpLiteral(host: string): string | null {
	// A hostname is not an address, and guessing is what would be dangerous: an
	// over-eager reduction that turned `0x7f.example` into an address would make
	// a real host into a loopback one. The test is therefore "does a URL parser
	// read this as an address", which is exactly the question being asked.
	const candidate = isIP(host) === 6 ? `[${host}]` : host;
	let parsed: string;
	try {
		parsed = new URL(`http://${candidate}`).hostname;
	} catch {
		return null;
	}
	// A hostname parses fine and comes back as itself; that is the "not an address"
	// answer, and it is the common case here rather than an error path.
	if (isIP(parsed.replace(/^\[|\]$/g, "")) === 0) return null;
	// Brackets off, to match what `normalizeHost` has always returned for
	// `[::1]:8080` — which is `::1`, and which `domainMatches` has always been
	// handed. Changing that shape would silently unmatch every rule written for
	// an IPv6 literal.
	return parsed.replace(/^\[|\]$/g, "");
}

// Long-form design notes: docs/dev/sandbox.md
/** Reduce a host as a client wrote it to the form the rules are written in. */
export function normalizeHost(raw: string): string {
	let host = raw.trim();
	if (host === "") return "";

	// `[::1]:8080` and `[::1]` — the brackets are what make the port unambiguous.
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close < 0) return "";
		host = host.slice(1, close);
	} else {
		// A bare `host:port`. Counted colons: an unbracketed IPv6 literal has
		// several, and splitting one would turn `::1` into an empty host.
		const colons = host.split(":").length - 1;
		if (colons === 1) host = host.slice(0, host.indexOf(":"));
	}

	host = host.toLowerCase();
	// One trailing dot is the root label written out. Two is not a host.
	while (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);

	// Refuse what is left if it cannot be a host at all: unplaceable input comes
	// back empty, and the set is the one a hostname or IP literal is written from.
	// Long-form design notes: docs/dev/sandbox.md
	if (!/^[a-z0-9._:%-]+$/.test(host)) return "";

	// Last, because it is the only step that can *change* what a rule is matched
	// against rather than only tidy it. A host that reduces to an address is
	// replaced by that address's one spelling; one that does not is left exactly
	// as it was, so nothing here can turn a hostname into something else.
	return canonicalIpLiteral(host) ?? host;
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether two IP literals name the same machine. The one place families merge, for loopback only. */
function sameIpAddress(a: string, b: string): boolean {
	if (a === b) return true;
	return isLoopbackHost(a) && isLoopbackHost(b);
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether an already-canonical literal reaches this machine's loopback, IPv4-mapped forms included. */
function isLoopbackLiteral(literal: string): boolean {
	if (/^127\./.test(literal)) return true;
	if (literal === "::1") return true;
	if (!literal.startsWith("::ffff:")) return false;
	const groups = literal.slice("::ffff:".length).split(":");
	if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
	return Number.parseInt(groups[0], 16) >> 8 === 127;
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether a host — a name or a literal — reaches this machine's loopback. */
function isLoopbackHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const literal = canonicalIpLiteral(host);
	return literal !== null && isLoopbackLiteral(literal);
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether an address literal is one this build refuses to fetch or connect to. */
export function isBlockedAddress(address: string): boolean {
	const literal = canonicalIpLiteral(address);
	if (literal === null) return false;

	// An IPv6 literal that carries an IPv4 address reaches the same destination
	// as that address does, so it is handed back as dotted and one range table
	// answers for both families. Reading the groups is what makes the *hex*
	// spelling work, which the dotted-only recursion this replaces did not — and
	// it is what makes NAT64 and 6to4 work at all, since those are routes to an
	// IPv4 destination rather than ways of writing one.
	const mapped = embeddedIpv4(literal);
	if (mapped !== null) return isBlockedAddress(mapped);

	if (isIP(literal) === 4) {
		const octets = literal.split(".").map(Number);
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
	// Everything reaching here is IPv6. `canonicalIpLiteral` returns the output of
	// a URL parser for a string `isIP` accepted, and the IPv4 branch above has
	// taken the IPv4, so `isIP(literal) === 6` is a property of the two lines
	// above rather than a check this line repeats.
	const groups = ipv6Groups(literal);
	const first = groups?.[0];
	if (first === undefined) return true;

	// 0000::/8. RFC 4291 §2.6.2 reserves the whole /8 and says it is to be used
	// only as the source of a request that has not yet chosen a source, so
	// nothing legitimate is a destination there. `::` and `::1` are both inside
	// it, which is why neither needs a line of its own.
	if (first === 0) return true;
	// fc00::/7 — unique local. `fc` and `fd` are the two halves of one /7, and
	// the mask says so where two string prefixes only appeared to.
	if ((first & 0xfe00) === 0xfc00) return true;
	// fe80::/10 — link local, and this one was a real defect. The check read
	// `startsWith("fe80:")`, which is a single /16 of a /10: fe80::/10 runs
	// through febf, and `fe81::1` through `febf::1` — seven of the sixteen
	// link-local blocks — came back unblocked. Measured on all eight before this
	// line changed, not reasoned about. The mask is the range.
	if ((first & 0xffc0) === 0xfe80) return true;
	// fec0::/10 — site local. Deprecated by RFC 3879 and superseded by the
	// unique-local range above, but a network that never migrated still routes
	// it, and it reaches a LAN, which is the reason the private ranges are
	// refused at all.
	if ((first & 0xffc0) === 0xfec0) return true;
	// ff00::/8 — multicast — is deliberately **not** here. Every caller in this
	// build reaches a destination over TCP, where a multicast group is not a
	// destination, so adding it would refuse nothing and read as coverage. A
	// caller that opens a UDP socket would need it and would have to add it.
	return false;
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether a host off the wire is one this build refuses: addresses and the names that mean them. */
export function isBlockedNetworkHost(host: string): boolean {
	const normalized = normalizeHost(host);
	if (normalized === "") return false;
	return isLoopbackHost(normalized) || isBlockedAddress(normalized);
}

// Long-form design notes: docs/dev/sandbox.md
/** The eight 16-bit groups of an IPv6 literal, or `null` when the string is not one this can read. */
function ipv6Groups(literal: string): number[] | null {
	const halves = literal.toLowerCase().split("::");
	if (halves.length > 2) return null;
	const parse = (part: string): number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
			groups.push(Number.parseInt(piece, 16));
		}
		return groups;
	};
	if (halves.length === 1) {
		const groups = parse(halves[0]);
		return groups !== null && groups.length === 8 ? groups : null;
	}
	const head = parse(halves[0]);
	const tail = parse(halves[1]);
	if (head === null || tail === null) return null;
	// `::` stands for at least one group, which is why this is `< 1` and not
	// `< 0` — `1:2:3:4:5:6:7::` names nine groups and is not an address.
	const elided = 8 - head.length - tail.length;
	if (elided < 1) return null;
	return [...head, ...new Array<number>(elided).fill(0), ...tail];
}

// Long-form design notes: docs/dev/sandbox.md
/** The two groups at `index`, or `null` when the literal is shorter than that. */
function pairAt(groups: number[], index: number): [number, number] | null {
	const high = groups[index];
	const low = groups[index + 1];
	return high === undefined || low === undefined ? null : [high, low];
}

/** Two 16-bit groups as the dotted quad they spell: `7f00`,`1` is `127.0.0.1`. */
function dottedQuad(high: number, low: number): string {
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// Long-form design notes: docs/dev/sandbox.md
/** The IPv4 address an IPv6 literal carries inside it, in dotted form, or `null` when it carries none. */
function embeddedIpv4(literal: string): string | null {
	const groups = ipv6Groups(literal);
	if (groups === null) return null;
	const tail = pairAt(groups, 6);
	if (tail === null) return null;
	// `::ffff:0:0/96` — five zero groups, then `ffff`, then the address.
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return dottedQuad(tail[0], tail[1]);
	}
	// `64:ff9b::/96` — the NAT64 well-known prefix, then four zero groups.
	if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
		return dottedQuad(tail[0], tail[1]);
	}
	// `2002::/16` — 6to4, whose address sits in groups one and two.
	if (groups[0] === 0x2002) {
		const embedded = pairAt(groups, 1);
		return embedded === null ? null : dottedQuad(embedded[0], embedded[1]);
	}
	return null;
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether `host` is covered by `pattern`. See `NetworkDomainRule.pattern`. */
export function domainMatches(pattern: string, host: string): boolean {
	const trimmed = pattern.trim();
	if (trimmed === "") return false;
	if (trimmed === "*") return true;

	if (trimmed.startsWith("*.")) {
		const p = trimmed.slice(2).toLowerCase();
		return host.endsWith(`.${p}`) || host === p;
	}
	if (trimmed.startsWith(".")) {
		const p = trimmed.toLowerCase();
		return host.endsWith(p) || host === p.slice(1);
	}

	const p = normalizeHost(trimmed);
	if (p === "") return false;
	if (p === host) return true;
	// Two addresses that reach the same interface. Only for IP literals: a
	// hostname pair never gets here, because `canonicalIpLiteral` returns null
	// for anything that is not an address.
	return sameIpAddress(p, host);
}

// Long-form design notes: docs/dev/sandbox.md
/** The verdict the rules carry for `host`, or `undefined` if none covers it. */
export function matchDomainRule(
	rules: readonly NetworkDomainRule[],
	host: string,
): NetworkDomainPermission | undefined {
	for (const rule of rules) {
		if (rule.permission === "deny" && domainMatches(rule.pattern, host)) return "deny";
	}
	for (const rule of rules) {
		if (rule.permission === "allow" && domainMatches(rule.pattern, host)) return "allow";
	}
	return undefined;
}

// Long-form design notes: docs/dev/sandbox.md
/** Decide one request. Three rules, and the order of the first two is the security property. */
export function decideNetworkRequest(
	rules: readonly NetworkDomainRule[],
	host: string,
	mode: "restricted" | "enabled",
): NetworkDecision {
	const normalized = normalizeHost(host);
	if (normalized === "") return { allowed: false, reason: "malformed_host" };

	const matched = matchDomainRule(rules, normalized);
	if (matched === "deny") return { allowed: false, reason: "domain_denied" };
	if (matched === "allow") return { allowed: true };

	if (mode === "restricted") return { allowed: false, reason: "no_matching_allow_rule" };
	return { allowed: true };
}

// Long-form design notes: docs/dev/sandbox.md
/** Whether this policy needs a proxy in front of it at all. */
export function needsNetworkProxy(network: "restricted" | "enabled", rules: readonly NetworkDomainRule[]): boolean {
	return network === "restricted" || rules.length > 0;
}

// Long-form design notes: docs/dev/sandbox.md
/** What, if anything, holds the network boundary besides the proxy. Five answers, not a boolean. */
export type NetworkConfinement =
	/** An OS sandbox wraps the command and denies outbound traffic at the kernel. */
	| "os-namespace"
	/** No argv-level backend exists for this platform, so nothing wraps the shell. */
	| "no-os-backend"
	/** A backend exists for this platform but is not installed here. */
	| "backend-missing"
	/** A backend is wrapping, but the network is open inside it. */
	| "network-left-open"
	/** A backend is installed and nothing wrapped the shell anyway. */
	| "filesystem-axis-off";

// Long-form design notes: docs/dev/sandbox.md
/** The four one-line reasons, one per case. Held apart so the shared tail stays identical. */
const REASON_BY_CONFINEMENT: Record<Exclude<NetworkConfinement, "os-namespace">, string> = {
	"no-os-backend": "This build ships no OS-level sandbox for this platform.",
	"backend-missing": "The sandbox backend is not installed here, so nothing below the proxy is enforcing anything.",
	"filesystem-axis-off":
		"This session's sandbox axis is off, so no wrapper is around the command even where one could be.",
	"network-left-open": "The sandbox leaves the network open so allowed traffic can get through.",
};

// Long-form design notes: docs/dev/sandbox.md
/** The one-line reason a given confinement has the proxy as the whole boundary. */
export function networkConfinementReason(confinement: Exclude<NetworkConfinement, "os-namespace">): string {
	return REASON_BY_CONFINEMENT[confinement];
}

/** One sentence saying what the network half is actually doing. */
export function describeNetworkPolicy(
	network: "restricted" | "enabled",
	rules: readonly NetworkDomainRule[],
	confinement: NetworkConfinement,
): string {
	if (!needsNetworkProxy(network, rules)) {
		return "Network: not restricted. Commands reach whatever the host can reach, and no proxy is interposed.";
	}
	const count = rules.filter((rule) => rule.permission === "allow").length;

	// `os-namespace` gets its own detail because the shared sentence is false there:
	// a command reaches nothing, and the list names domains rather than ports.
	// Long-form design notes: docs/dev/sandbox.md
	const detail =
		confinement === "os-namespace" && count > 0
			? `A command run through the shell reaches nothing at all here, so the ${count} listed domain${count === 1 ? "" : "s"} are what the web tools may fetch rather than what a command may reach.`
			: network === "restricted"
				? count === 0
					? "Nothing is reachable: the network is restricted and no domain is allowed."
					: `Only the ${count} listed domain${count === 1 ? "" : "s"} may be reached, on any port — the list names domains, not ports.`
				: `Traffic is routed through a local proxy that refuses the ${rules.length - count} denied pattern${rules.length - count === 1 ? "" : "s"}.`;

	// Written per case, because "the OS holds the rest" and "nothing but the proxy
	// holds it" are opposite facts. The `os-namespace` half names the proxy too.
	// Long-form design notes: docs/dev/sandbox.md
	const caveat =
		confinement === "os-namespace"
			? " The OS sandbox denies the command every route off the machine, the proxy included — so ignoring the proxy environment gains a program nothing, and a command that would have been allowed is refused too."
			: ` ${REASON_BY_CONFINEMENT[confinement]} So the proxy is the whole network boundary: a program that opens a socket without consulting the proxy environment is not subject to it.`;

	return `Network: restricted. ${detail}${caveat} The web tools are covered by this too, since they fetch in this process where the proxy is not in the path.`;
}
