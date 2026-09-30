/**
 * Which hosts a confined command may reach, decided as a value.
 *
 * Pure, like `sandbox-policy.ts` next door and for the same reason: the proxy
 * that enforces this is the only part that touches a socket, so the decision
 * can be asserted on any machine, including the Windows one this was written
 * on. The shape follows Codex's `NetworkDomainPermission`
 * (`config/src/permissions_toml.rs:278`) — a table of pattern to `allow` or
 * `deny` — with the pieces this build does not have (unix sockets, remote
 * config, MITM) left out rather than stubbed.
 *
 * ## What "enforced" means here, stated once
 *
 * This decides what the **proxy** permits. It does not, by itself, stop a
 * program that opens a socket without consulting the proxy environment —
 * `HTTP_PROXY` is a convention that most developer tooling honours, not a
 * kernel boundary. Where the platform has one, the OS sandbox is what closes
 * that gap, and the two are layered rather than confused:
 *
 *   - macOS / Linux: `sandbox-exec` / `bwrap` hold the network boundary at the
 *     kernel. When domain rules narrow an otherwise-enabled network the profile
 *     is narrowed to loopback so only the proxy is reachable, and everything
 *     else is unreachable without going through the decision in this file.
 *   - Windows: there is no such backend, so this file and the proxy are the
 *     whole of the network story. That is stated in `/permissions` and `/doctor`
 *     rather than papered over, for the same reason the filesystem half is.
 *
 * A user told "the network is restricted" on a machine where a program can
 * ignore the proxy has been told something false, so the honest sentence is
 * per-platform and derived from the same resolution the env is.
 */

/**
 * Per-pattern verdicts, as a value rather than a bare type.
 *
 * The same reasoning `PERMISSION_MODES` has: a `z.enum(["allow", "deny"])`
 * written by hand in the settings file is a second copy of this list, and a
 * third verdict added here would be a value that schema rejects. Deriving it
 * from here is what makes the schema incapable of drifting.
 */
export const NETWORK_DOMAIN_PERMISSIONS = ["allow", "deny"] as const;

/** Per-pattern verdict. Mirrors Codex's `NetworkDomainPermissionToml`. */
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
 * There is no "the mode said no" code, because there is no case only the mode
 * can produce: a request the mode refuses is one that matched no rule, and a
 * request that matched a rule was already answered by that rule. A fourth code
 * that nothing can return would be a reason string with no request behind it.
 */
export type NetworkDenialReason = "domain_denied" | "no_matching_allow_rule" | "malformed_host";

export interface NetworkDecision {
	allowed: boolean;
	/** Present only when refused; the machine-readable half of the answer. */
	reason?: NetworkDenialReason;
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
	return /^[a-z0-9._:%-]+$/.test(host) ? host : "";
}

/** Whether `host` is covered by `pattern`. See `NetworkDomainRule.pattern`. */
export function domainMatches(pattern: string, host: string): boolean {
	const p = pattern.trim().toLowerCase();
	if (p === "") return false;
	if (p === "*") return true;

	// Both suffix spellings collapse to one comparison here. The leading dot is
	// already the boundary: `host.endsWith(".example.com")` cannot be satisfied
	// by `evil-example.com`, which is exactly the case a bare `endsWith` gets
	// wrong.
	if (p.startsWith("*.")) return host.endsWith(p.slice(1)) || host === p.slice(2);
	if (p.startsWith(".")) return host.endsWith(p) || host === p.slice(1);
	return host === p;
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

/** One sentence saying what the network half is actually doing. */
export function describeNetworkPolicy(
	network: "restricted" | "enabled",
	rules: readonly NetworkDomainRule[],
	platform: string,
): string {
	if (!needsNetworkProxy(network, rules)) {
		return "Network: not restricted. Commands reach whatever the host can reach, and no proxy is interposed.";
	}
	const count = rules.filter((rule) => rule.permission === "allow").length;
	const detail =
		network === "restricted"
			? count === 0
				? "Nothing is reachable: the network is restricted and no domain is allowed."
				: `Only the ${count} listed domain${count === 1 ? "" : "s"} may be reached.`
			: `Traffic is routed through a local proxy that refuses the ${rules.length - count} denied pattern${rules.length - count === 1 ? "" : "s"}.`;

	// Windows has no OS backend in this build, so on that platform the proxy is
	// the entire boundary and it is enforced by convention rather than by the
	// kernel. Saying so here is the same obligation the filesystem half has.
	const caveat =
		platform === "darwin" || platform === "linux"
			? " The OS sandbox holds the rest of the boundary, so a program that ignores the proxy environment still reaches nothing."
			: " This platform has no OS-level network backend in this build, so the proxy is the whole boundary: a program that opens a socket without consulting the proxy environment is not subject to it.";

	return `Network: restricted. ${detail}${caveat}`;
}
