/**
 * Which hosts a confined command may reach, decided as a value.
 *
 * Pure, like `sandbox-policy.ts` next door and for the same reason: the proxy
 * that enforces this is the only part that touches a socket, so the decision
 * can be asserted on any machine, including the Windows one this was written
 * on. The shape is a table of host pattern to `allow` or `deny`, with the
 * pieces this build does not have (unix sockets, remote config, MITM) left out
 * rather than stubbed.
 *
 * ## What "enforced" means here, stated once
 *
 * This decides what the **proxy** permits. It does not, by itself, stop a
 * program that opens a socket without consulting the proxy environment —
 * `HTTP_PROXY` is a convention that most developer tooling honours, not a
 * kernel boundary. Where the platform has one, the OS sandbox is what closes
 * that gap, and the two are layered rather than confused:
 *
 *   - macOS / Linux, `enabled`: the OS confines the filesystem and leaves the
 *     network open, so the proxy is still the whole of the *network* boundary
 *     and a program that ignores the environment gets out. Reported as
 *     `network-left-open` rather than as a kernel-held line.
 *   - macOS / Linux, `restricted`: the OS denies the command **every** route
 *     off the machine. Not "loopback only" — the profile starts from
 *     `(deny default)` and adds no network rule at all (`seatbelt.ts`), and
 *     `--unshare-net` puts the command in an empty network namespace
 *     (`bwrap.ts`). The consequence is worth stating plainly because it is the
 *     opposite of what the setting sounds like: **the proxy is unreachable
 *     from the shell too, so this domain list governs the web tools — which
 *     fetch in this process — and not a command run through Bash.** A shell
 *     command reaches nothing, allowed or denied.
 *   - Windows: there is no such backend, so this file and the proxy are the
 *     whole of the network story. That is stated in `/permissions` and `/doctor`
 *     rather than papered over, for the same reason the filesystem half is.
 *
 * That middle bullet used to say the profile was "narrowed to loopback so only
 * the proxy is reachable". No code did that, on either platform, and the
 * sentence described a design rather than the build. Narrowing a seatbelt
 * profile to loopback is expressible; the equivalent is **not** available for
 * `--unshare-net`, whose namespace has no route to the host's loopback at all
 * without a userspace routing bridge.
 * A loopback-narrowed macOS profile next to an unreachable-proxy Linux one
 * would be two behaviours under one setting, so neither is done and the
 * setting means what it does.
 *
 * A user told "the network is restricted" on a machine where a program can
 * ignore the proxy has been told something false, so the honest sentence is
 * per-platform and derived from the same resolution the env is.
 */
import { isIP } from "node:net";

/**
 * Per-pattern verdicts, as a value rather than a bare type.
 *
 * The same reasoning `PERMISSION_MODES` has: a `z.enum(["allow", "deny"])`
 * written by hand in the settings file is a second copy of this list, and a
 * third verdict added here would be a value that schema rejects. Deriving it
 * from here is what makes the schema incapable of drifting.
 */
export const NETWORK_DOMAIN_PERMISSIONS = ["allow", "deny"] as const;

/** Per-pattern verdict. */
export type NetworkDomainPermission = (typeof NETWORK_DOMAIN_PERMISSIONS)[number];

export interface NetworkDomainRule {
	/**
	 * A host pattern. Four spellings, and the difference between the last two is
	 * the difference between a suffix match and a substring match:
	 *
	 *   `*`             any host
	 *   `example.com`   exactly that host, **not** `api.example.com`
	 *   `.example.com`  that host and every subdomain
	 *   `*.example.com` the same, spelled the way people write it
	 *
	 * The exact form deliberately does not match subdomains. A pattern that
	 * matched them would need `endsWith` plus a `.` boundary check to stay
	 * correct, and the spelling that carries the intent is the one that costs
	 * nothing to get right — an allowlist that quietly widens to every
	 * subdomain of everything in it is a very quiet way to not be confining.
	 */
	pattern: string;
	permission: NetworkDomainPermission;
}

/**
 * Why a request was refused. Carried so the proxy can answer in words.
 *
 * The first three are the rule engine's, and there is deliberately no "the mode
 * said no" code among them: a request the mode refuses is one that matched no
 * rule, and a request that matched a rule was already answered by that rule. A
 * fourth code from the engine would be a reason string with no request behind
 * it.
 *
 * `blocked_address` is that fourth code, and it exists because the set of things
 * that can refuse grew rather than because the reasoning above was wrong. An
 * address the blocklist refuses is a request the rules never see: `*` under
 * `restricted` answers `allowed: true` for `127.0.0.1` and for
 * `169.254.169.254`, so with only these three codes a refusal by the blocklist
 * would have to be reported as one of the rule engine's, and the user would go
 * looking for an allowlist entry that was never the problem.
 */
export type NetworkDenialReason = "domain_denied" | "no_matching_allow_rule" | "malformed_host" | "blocked_address";

export interface NetworkDecision {
	allowed: boolean;
	/** Present only when refused; the machine-readable half of the answer. */
	reason?: NetworkDenialReason;
}

/**
 * The one spelling of an IP literal that everything else reduces to.
 *
 * `normalizeHost` handles the *syntactic* wrappers — case, brackets, a trailing
 * port, the root label's dot. It did not handle the address itself, and an
 * address has more spellings than that. Measured on this repository's own
 * inputs, a `deny` rule written for `127.0.0.1` caught exactly one of these:
 *
 *     127.0.0.1     caught
 *     127.0.0.01    not caught      extra leading zero in an octet
 *     127.1         not caught      the short form, two parts
 *     0177.0.0.1    not caught      octal
 *     0x7f000001    not caught      hex
 *     2130706433    not caught      the whole thing as one integer
 *
 * `domainMatches` reduces to `host === pattern`, so each of those five was a
 * host the proxy judged as an unrelated name and — under `enabled` — permitted.
 * A user who wrote the rule got nothing, and the way to find that out was to
 * notice the rule was not in the list of things it stopped.
 *
 * WHATWG URL parsing is the reducer, not a hand-rolled one: it is the same
 * parser `new URL()` applies to every URL this process builds, it is already
 * the thing standing between a `WebFetch` URL and `isBlockedAddress`, and a
 * second implementation of IPv4 parsing is a second set of answers to "what
 * does `0177.0.0.1` mean". Measured, it maps all five forms above onto
 * `127.0.0.1`, and it fully compresses IPv6 (`0:0:0:0:0:0:0:1` → `::1`,
 * `2001:0db8::1` → `2001:db8::1`).
 *
 * **What it deliberately does not do: merge the address families.** `::1` and
 * `127.0.0.1` are both loopback and both reach the same interface, but they are
 * two addresses rather than two spellings of one, and collapsing them would be a
 * policy decision taken inside a normaliser. It is taken explicitly instead, in
 * {@link sameIpAddress}, which is the only place allowed to make it.
 *
 * A host that is not an address is returned as `null` rather than as itself, so
 * the caller can tell "not an address" from "an address that failed to parse" —
 * and the latter is impossible here, because the only inputs reaching this are
 * strings that already survived the character filter below.
 */
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

/**
 * Reduce a host as a client wrote it to the form the rules are written in.
 *
 * A client asks for `EXAMPLE.com:443`, `[::1]:8080`, `example.com.` and
 * `example.com` and means one thing by all four. Anything that compared the
 * raw string would let the first three past a rule written for the fourth,
 * which for an allowlist is the difference between a restriction and a
 * decoration.
 *
 * Returns the empty string for input it cannot place, and the caller treats
 * that as a refusal — an unparseable host is not a host to be given the benefit
 * of the doubt.
 */
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

	// Refuse what is left if it cannot be a host at all. Splitting off the port
	// of `]:80` leaves `]`, and a caller that trusted this function would then
	// be matching rules against a stray bracket — it would match nothing today,
	// but "matches nothing" is a property of the rules, not of the input, and
	// the contract here is that unplaceable input comes back empty.
	//
	// The set is the one a hostname or IP literal is written from: letters,
	// digits, `-`, `.`, `:` for IPv6 and `%` for an IPv6 zone id. Anything a
	// real client sends is punycoded before it gets here, so a non-ASCII host
	// is not a case to make room for.
	if (!/^[a-z0-9._:%-]+$/.test(host)) return "";

	// Last, because it is the only step that can *change* what a rule is matched
	// against rather than only tidy it. A host that reduces to an address is
	// replaced by that address's one spelling; one that does not is left exactly
	// as it was, so nothing here can turn a hostname into something else.
	return canonicalIpLiteral(host) ?? host;
}

/**
 * Whether two IP literals name the same machine.
 *
 * The one place families are allowed to merge, and only for loopback.
 *
 * Canonicalisation above settles the *spelling* question: five ways of writing
 * `127.0.0.1` are now one string. It deliberately does not answer the different
 * question of whether `::1` and `127.0.0.1` are the same destination, because
 * they are two addresses that happen to reach one interface — a fact about the
 * network, not about the string.
 *
 * But a `deny` rule is a user's statement about a destination, and a user who
 * wrote `127.0.0.1` and then reached the proxy with `::1` was refused by nothing
 * and permitted by everything. Both addresses land on the loopback interface,
 * so a rule naming either one is naming where the connection goes. Every other
 * range is left alone: `10.0.0.1` and `fd00::1` are *not* interchangeable, and
 * treating them as one would make a deny silently cover addresses the user
 * never named — the failure mode that has the opposite sign but the same cause.
 *
 * **The reserved name belongs here too, and leaving it out was a hole.** The
 * first version of this function merged literals only, on the reasoning that
 * where a *name* points is the resolver's business. Measured, that reasoning
 * cost exactly the thing it was protecting: with `allow *` and `deny 127.0.0.1`
 * in force, every loopback spelling was refused and `localhost` was permitted —
 * one word, the spelling a user is most likely to actually type. `localhost`
 * needs no resolution to place it, because RFC 6761 §6.3 reserves it and its
 * subdomains to loopback; see {@link isLoopbackHost}.
 *
 * Expressed through the same address the rules are matched on, so it cannot
 * disagree with {@link normalizeHost} about what a host is.
 */
function sameIpAddress(a: string, b: string): boolean {
	if (a === b) return true;
	return isLoopbackHost(a) && isLoopbackHost(b);
}

/**
 * Whether an already-canonical literal reaches this machine's loopback.
 *
 * **Includes IPv4-mapped IPv6.** `::ffff:127.0.0.1` and `::1` both land on the
 * loopback interface, and a deny rule that stopped the first while permitting
 * the second would be stopping a spelling rather than a destination — the same
 * defect canonicalisation exists to remove, one layer up. The other half of this
 * repo's blocklist is this same function: `web.ts` imports `isBlockedAddress`
 * from here rather than keeping a private copy, so there is no second table for
 * two halves to drift apart over. That was not true before this batch — the two
 * copies had already drifted, and the comment that then stood here claimed they
 * agreed while `isBlockedAddress("::ffff:7f00:1")` returned false.
 *
 * **Every input is already canonical**, which is why there is no dotted-form
 * handling below: `canonicalIpLiteral` reduces `::ffff:127.0.0.1` to
 * `::ffff:7f00:1` on its way past, and this function's only caller
 * ({@link sameIpAddress}) hands it the output of that. A branch here for the
 * dotted spelling would be a line that cannot run under a comment saying it
 * sometimes does, which is the kind of claim this repository treats as its most
 * expensive error.
 *
 * The embedded IPv4 occupies the low 32 bits, so its **first** octet is the
 * high byte of the first hextet: `127.0.0.1` is `7f00:0001`, and asking whether
 * it is loopback is asking whether the high byte is `0x7f`. Only that byte is
 * read — the other three are `127.0.0.x`, which is loopback too, so there is
 * nothing in them left to check.
 */
function isLoopbackLiteral(literal: string): boolean {
	if (/^127\./.test(literal)) return true;
	if (literal === "::1") return true;
	if (!literal.startsWith("::ffff:")) return false;
	const groups = literal.slice("::ffff:".length).split(":");
	if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
	return Number.parseInt(groups[0], 16) >> 8 === 127;
}

/**
 * Whether a host — a name or a literal — reaches this machine's loopback.
 *
 * **The reserved name is included on purpose, and no lookup happens.** RFC 6761
 * §6.3 reserves `localhost` and its subdomains to loopback and says name
 * resolution APIs "SHOULD recognize localhost names as special"; it is a
 * statement about the name, not a claim about one resolver's answer, so placing
 * it needs no DNS and must not do any. Resolving here would be the wrong fix
 * twice over: it would make a pure matcher impure, and it would re-open the gap
 * that resolving-and-then-connecting leaves open, where the name is checked once
 * and connected to on a second lookup.
 *
 * Callers pass values that {@link normalizeHost} has already lowercased and
 * stripped of its trailing dot, so the comparison is against the reduced form.
 */
function isLoopbackHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const literal = canonicalIpLiteral(host);
	return literal !== null && isLoopbackLiteral(literal);
}

/**
 * Whether an address literal is one this build refuses to fetch or connect to:
 * loopback, private, link-local, or the shared and zero ranges beside them.
 *
 * **This used to live in `web.ts` and was moved here so there is one table.**
 * Two copies is not tidiness — they had already drifted. The copy in `web.ts`
 * unwrapped `::ffff:` into its dotted tail, which handles `::ffff:127.0.0.1` and
 * not `::ffff:7f00:1`, and a comment in this file asserted the two agreed about
 * which literals are loopback while measurement said the `web.ts` half answered
 * false for the hex spelling. Canonicalising first is what closes that: the
 * reduced form is the only one the range checks below ever see.
 *
 * Addresses only, never names. A name is not blocked by this — it is *resolved*
 * by the caller, and every address that comes back is passed through here
 * (`web.ts`, `guardPublicUrl`). `localhost` is refused by rule rather than by
 * table, one layer up in {@link isLoopbackHost}, because its placement is a
 * property of the name.
 */
export function isBlockedAddress(address: string): boolean {
	const literal = canonicalIpLiteral(address);
	if (literal === null) return false;

	// An IPv4-mapped IPv6 address reaches the same interface as the IPv4 it
	// carries, so it is handed back as dotted and one range table answers for
	// both families. Reading the two hextets is what makes the *hex* spelling
	// work, which the dotted-only recursion this replaces did not.
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
	const lower = literal.toLowerCase();
	if (lower === "::1") return true; // loopback
	if (lower.startsWith("fe80:")) return true; // link-local
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
	return false;
}

/**
 * Whether a host arriving off the wire is one this build refuses to reach —
 * addresses *and* the names that mean them. This is the whole blocklist; the two
 * functions under it each know one half.
 *
 * `isBlockedAddress` above takes an address and refuses every non-address,
 * `localhost` included, because a name is not blocked by table — it is resolved,
 * and a resolved name is only blocked once it comes back as one of these
 * addresses. That is the right contract for a caller that has already resolved.
 * It is the wrong one for a caller reading a hostname off a socket: `localhost`
 * arrives as a name, is never resolved here, and would be relayed to whatever
 * `/etc/hosts` says. `isLoopbackHost` is the layer that knows the name, and it
 * could not simply be exported, because it does no case folding and assumes the
 * caller ran {@link normalizeHost} first — a precondition the proxy's three
 * entry points each met differently, and one a future fourth entry point would
 * not.
 *
 * So this normalises first and is the only thing callers should reach for. That
 * is also what makes it total over the shapes the wire actually produces:
 * `[::1]` (which is what `new URL("http://[::1]:8080/").hostname` returns),
 * `[2001:db8::1]:8080`, `LOCALHOST`, `127.1` and `0177.0.0.1` all reduce to one
 * string each and all answer the same way.
 *
 * **A host that will not normalise is not blocked here.** It is refused by the
 * rule engine as `malformed_host`, and reporting it as an address problem would
 * point at the wrong one of the two.
 */
export function isBlockedNetworkHost(host: string): boolean {
	const normalized = normalizeHost(host);
	if (normalized === "") return false;
	return isLoopbackHost(normalized) || isBlockedAddress(normalized);
}

/**
 * The IPv4 address an IPv4-mapped IPv6 literal carries, in dotted form, or `null`
 * when it carries none. `::ffff:7f00:1` and `::ffff:127.0.0.1` are the same
 * address written two ways, and canonicalisation reduces the first to the second
 * shape — which is exactly why the reduction has to be undone here rather than
 * left to the range table.
 */
function embeddedIpv4(literal: string): string | null {
	if (!literal.startsWith("::ffff:")) return null;
	const groups = literal.slice("::ffff:".length).split(":");
	if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	const high = Number.parseInt(groups[0], 16);
	const low = Number.parseInt(groups[1], 16);
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Whether `host` is covered by `pattern`. See `NetworkDomainRule.pattern`.
 *
 * The pattern goes through `normalizeHost` too, and that is not tidiness. Both
 * sides have to reduce by the *same* function or the reduction is a one-way
 * street: canonicalising the host alone would mean a rule written `[::1]` no
 * longer matches the host it was written for, which is the same class of bug as
 * the one the canonicalisation was added to fix.
 *
 * `*` and the two suffix spellings are checked before normalisation, because a
 * pattern containing `*` or a leading dot is a hostname pattern and cannot be an
 * address — running it through a URL parser to find that out would be the kind
 * of clever that surprises someone in a year.
 */
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

/**
 * The verdict the rules carry for `host`, or `undefined` if none covers it.
 *
 * **`deny` is looked for across the whole table before `allow` is considered
 * anywhere in it.** Returning the first match instead would make the table
 * order-sensitive: `{allow: "*"}, {deny: "evil.com"}` would then permit exactly
 * the host the user wrote a rule to block, and the fix would be to reorder the
 * settings file — which is not a property a security table should have. This
 * is the same deny-before-allow shape the permission engine runs, for the same
 * reason.
 */
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

/**
 * Decide one request.
 *
 * Three rules, and the ordering of the first two is the security property:
 *
 *  1. **`deny` beats `allow` regardless of order in the list.** This is the
 *     same invariant the permission engine runs on — a user's `deny` is not
 *     overridable — and a table where a later `allow` could rescue an earlier
 *     `deny` would make the table order-sensitive in the one direction that
 *     matters.
 *  2. **`restricted` permits only an explicit `allow`.** No rules means nothing
 *     is reachable, which is the fail-closed reading; the alternative — treating
 *     an empty table as "allow" — would make turning the restriction on with no
 *     configuration a way to turn it off.
 *  3. **`enabled` with no matching rule permits**, because that is today's
 *     behaviour and a network that stopped working for every user who never
 *     configured a domain would not be a restriction, it would be an outage.
 *
 * A host that will not normalise is refused. There is no rule under which "I
 * could not parse what you asked for" is permission to proceed.
 */
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

/**
 * Whether this policy needs a proxy in front of it at all.
 *
 * Both cases do, and the reason they are one function rather than two call
 * sites is that "restricted" and "has rules" are the same decision seen from
 * two sides: either the mode forbids by default, or the rules narrow something
 * that would otherwise be open. `enabled` with no rules confines nothing, and
 * starting a proxy for it would cost a listening socket and a set of env vars
 * in every child process to enforce nothing — which is the shape of a security
 * control that only makes the word "sandbox" look better.
 */
export function needsNetworkProxy(network: "restricted" | "enabled", rules: readonly NetworkDomainRule[]): boolean {
	return network === "restricted" || rules.length > 0;
}

/**
 * What, if anything, holds the network boundary besides the proxy.
 *
 * The proxy is user-space by construction: it holds a command that consults
 * `HTTP_PROXY`, which is most commands and none of them by guarantee. Whether
 * something *else* also holds the line is a separate fact, and it is not the
 * same on every machine — which is why this is a type with five answers instead
 * of a boolean. Four of the five are "no", for four different reasons, and the
 * reason is what the user is owed.
 *
 * Declared here rather than reused from the sandbox module because this is the
 * agent package and the sandbox module is downstream of it: the agent half
 * states what it can say, and the caller derives which case applies from facts
 * only it knows. `networkConfinement` in `@labunbun/tools` is that derivation.
 */
export type NetworkConfinement =
	/**
	 * An OS sandbox wraps the command and denies outbound traffic at the kernel.
	 *
	 * The case this is written for is `restricted` under a native backend, and
	 * its consequence is the one a reader is most likely to get backwards: the
	 * denial covers the *proxy* too, because the proxy is reached over the same
	 * loopback the namespace has no route to. So a command run through the shell
	 * reaches nothing at all, whether its host is on the allowlist or not, and the
	 * domain list governs only the paths that fetch in this process. Saying "only
	 * the listed domains may be reached" here would be false about every domain
	 * on the list, in the direction that makes a dead network look like a working
	 * policy.
	 */
	| "os-namespace"
	/** No argv-level backend exists for this platform, so nothing wraps the shell. */
	| "no-os-backend"
	/** A backend exists for this platform but is not installed here. */
	| "backend-missing"
	/**
	 * A backend is wrapping, but the network is open inside it.
	 *
	 * Separate from the two above because this one is a choice rather than a
	 * gap: a sandbox that denied outbound would also deny the traffic the
	 * allowlist exists to permit, so the network has to stay open and the proxy
	 * is the whole boundary anyway. Reporting this as `os-namespace` would be
	 * true of the filesystem and false of the network.
	 */
	| "network-left-open"
	/**
	 * A backend is installed and nothing wrapped the shell anyway.
	 *
	 * `danger-full-access` is the absence of a *filesystem* sandbox, and
	 * `resolveSandboxExecution` short-circuits on it, so nothing is around the
	 * command on a machine that has `sandbox-exec` sitting right there. Reporting
	 * this as `os-namespace` — which is what the platform alone would suggest — is
	 * the one way this sentence could be confidently, smoothly, and completely
	 * wrong: everything about the platform says native and nothing about the
	 * command is confined.
	 */
	| "filesystem-axis-off";

/**
 * Why the proxy is the whole boundary, per case — and it is four different
 * answers to one question.
 *
 * Held apart from the shared tail so the tail can stay identical across all
 * four, which is the part that has to be identical: the claim is the same in
 * every one of them, and a reader who saw a differently-worded claim in one
 * case would have no way to know it meant the same thing. Only the reason is
 * allowed to differ, and it is the reason a user acts on.
 */
const REASON_BY_CONFINEMENT: Record<Exclude<NetworkConfinement, "os-namespace">, string> = {
	"no-os-backend": "This build ships no OS-level sandbox for this platform.",
	"backend-missing": "The sandbox backend is not installed here, so nothing below the proxy is enforcing anything.",
	"filesystem-axis-off":
		"This session's sandbox axis is off, so no wrapper is around the command even where one could be.",
	"network-left-open": "The sandbox leaves the network open so allowed traffic can get through.",
};

/**
 * The one-line reason a given confinement has the proxy as the whole boundary.
 *
 * A function rather than an exported table because the interesting mistake is the
 * one a `Record` invites: indexing it with a `NetworkConfinement` has to
 * account for `os-namespace`, which is the case with no reason here because it is
 * not a proxy-only boundary at all. Narrowing the parameter puts that fact in the
 * type instead of in a runtime check some caller would eventually skip.
 *
 * Exported because `/doctor` reports the same four cases and copying the strings
 * into a second surface is how two of them start disagreeing — which is exactly
 * what happened to the *shape* of this sentence once already.
 */
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

	// The `os-namespace` case gets its own `detail` because the sentence the other
	// four use is false here, and false in the way that costs a user an afternoon.
	// "Only the 2 listed domains may be reached" reads as a working allowlist; what
	// is actually true is that a command cannot reach the proxy the allowlist is
	// enforced at, so it reaches nothing, and the two listed domains are reachable
	// only from the web tools. The count is kept in the sentence because a user
	// comparing two sessions needs to see that the list did not change — what
	// changed is who can act on it.
	const detail =
		confinement === "os-namespace" && count > 0
			? `A command run through the shell reaches nothing at all here, so the ${count} listed domain${count === 1 ? "" : "s"} are what the web tools may fetch rather than what a command may reach.`
			: network === "restricted"
				? count === 0
					? "Nothing is reachable: the network is restricted and no domain is allowed."
					: `Only the ${count} listed domain${count === 1 ? "" : "s"} may be reached.`
				: `Traffic is routed through a local proxy that refuses the ${rules.length - count} denied pattern${rules.length - count === 1 ? "" : "s"}.`;

	// Written per case rather than as one sentence covering all five, because
	// "the OS holds the rest of the boundary" and "nothing but the proxy holds
	// it" are opposite facts and averaging them is how a proxy-only boundary
	// starts reading as a kernel-held one. This is the same obligation the
	// filesystem half carries in `describeSandboxBackend`, and the reason it used
	// to be wrong is the same one: it keyed off `process.platform`, so a Linux box
	// without bubblewrap and a Mac with `sandbox-exec` both printed the sentence
	// for a machine that has one, and the sentence claims the OS is holding
	// something.
	//
	// The scope of the gap is stated as carefully as the gap itself. "A program
	// that ignores the proxy environment" names subprocesses, and a user reading
	// only that would reasonably conclude the model's own tools are covered — which
	// was false until `WebFetch` and `WebSearch` were put under this same table.
	// They are named explicitly below because the caveat's silence about them was
	// an overclaim in its own right: it disclosed one bypass and let the reader
	// assume there was not another.
	//
	// The `os-namespace` half now names a second thing it used to leave out, which
	// is that the denial reaches the proxy as well. That is what makes the sentence
	// above say what it says, and leaving it out is what let the old wording claim
	// the list was governing a shell it never reaches.
	const caveat =
		confinement === "os-namespace"
			? " The OS sandbox denies the command every route off the machine, the proxy included — so ignoring the proxy environment gains a program nothing, and a command that would have been allowed is refused too."
			: ` ${REASON_BY_CONFINEMENT[confinement]} So the proxy is the whole network boundary: a program that opens a socket without consulting the proxy environment is not subject to it.`;

	return `Network: restricted. ${detail}${caveat} The web tools are covered by this too, since they fetch in this process where the proxy is not in the path.`;
}
