/**
 * The macOS backend: a `sandbox-exec` profile generated from a `SandboxPolicy`.
 *
 * Pure. No filesystem access, no `process.platform`, no clock — the caller
 * passes the policy and the command and gets back an argv. That is deliberate:
 * everything this file decides (which paths are writable, what order the denies
 * come in) is then assertable without a Mac, which is the only way to test it
 * from the machine this repository is built on.
 *
 * ## Shape
 *
 * The returned argv is the **argument vector after the program name**, exactly
 * as Codex returns it (`codex-rs/sandboxing/src/seatbelt.rs:1086-1095`):
 *
 *     ["-p", <profile>, "-D<KEY>=<value>", ..., "--", ...command]
 *
 * The caller prepends `/usr/bin/sandbox-exec`. It is spelled out rather than
 * absolute here because `sandbox-exec` must be the system binary and resolving
 * it through `PATH` is how an attacker substitutes their own; that check belongs
 * next to the spawn, which has the filesystem access this file does not.
 *
 * ## Paths are `-D` parameters, never profile text
 *
 * Every path reaches the profile through `(param "KEY")` plus a `-DKEY=value`
 * argument. This is the security property of the file, not a style choice: a
 * path interpolated into the profile text could carry `") (allow file-write*
 * (subpath "/` and close the string it was in, appending rules of its own.
 *
 * The reason that is safe is that `sandbox-exec` substitutes a `-D` value as an
 * opaque string and does not re-lex it as SBPL — so there is nothing for a path
 * to escape from. **That premise is inherited from Codex, which builds its argv
 * the same way (`seatbelt.rs:1087-1100`) and relies on the same behaviour; it
 * was not verified here from a Mac.** It is the load-bearing assumption of the
 * file: if a future `sandbox-exec` did re-lex parameter values, the escaping path
 * would be a `.git`-protect rule silently replaced by an attacker-chosen allow.
 * The cheap check is one command on a real Mac — a `-D` value containing
 * `(allow file-write*)` and see whether it takes effect — and it is a smoke test,
 * not a unit test.
 *
 * ## Denies come last
 *
 * A seatbelt profile resolves last-rule-wins. A `(deny ...)` emitted before the
 * broad `(allow file-read*)` or before a `(allow file-write* (subpath ...))`
 * that covers it is dead text that reads as a protection and is not one. So the
 * profile is assembled base → read baseline → writable roots → network → deny
 * entries → protected paths, with nothing after the protected block.
 */
import { canWrite, type SandboxPolicy } from "@labunbun/agent";

/**
 * The part of the profile that is not the policy: process control, the terminal,
 * and local IPC.
 *
 * Trimmed from `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` (116 lines).
 * What was left out and why:
 *
 *   - The enumerated `sysctl-name` list (about 40 `hw.*` / `kern.*` entries at
 *     `seatbelt_base_policy.sbpl:24-76`) is **not replaced by anything**. No
 *     sysctl rule is emitted, so under the `(deny default)` below every sysctl
 *     read is refused and a runtime that asks for `hw.ncpu` is told there are
 *     none. Whether bun or node can start under that is **not verified from a
 *     Mac** — it is the open question on this backend, and the sysctl lines are
 *     absent rather than widened because guessing a bare `(allow sysctl-read)`
 *     would hand every confined command the whole machine's hardware profile in
 *     exchange for a guess. Codex's list is the measured answer; copying it
 *     verbatim is the fix if the question comes back "no".
 *   - The `(ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")` filter on
 *     the shared-memory operations (`seatbelt_base_policy.sbpl:98-101`) is
 *     dropped; the three operations themselves are emitted bare, which is a
 *     widening. The claim that libomp then registers its segment under an
 *     unfiltered name is the working theory, not a measurement.
 *   - `(deny default)` and `(allow signal (target same-sandbox))` are kept
 *     verbatim — they are the closed-by-default posture the whole file rests on.
 *
 * `mach-lookup` is deliberately **not** widened. An unfiltered one is an escape
 * hatch to every Mach service the sandboxed process can reach, so only the two
 * services a process cannot start without are here; the network-service list
 * lives in the network section, which is emitted only when the policy enables
 * the network.
 *
 * **Operation names are literals; there is no wildcard in that position.** A
 * `*` there is not "every operation under this prefix", it is an unbound
 * variable — `sandbox-exec` refuses to compile the profile and exits 65, so
 * the symptom is a command that never runs carrying a parser backtrace instead
 * of a program. This file carried `(allow ipc-posix-sysv*)` for a while, and
 * that is not a real operation: Codex names the three SysV shared-memory
 * operations individually and has no sysv line at all
 * (`seatbelt_base_policy.sbpl:95-101`). Only the macOS job could find it,
 * because nothing outside a Mac parses SBPL.
 */
const BASE_POLICY = `(version 1)
(deny default)

; Process control, scoped to this sandbox so a child cannot signal out of it.
(allow process-fork)
(allow process-exec)
(allow signal (target same-sandbox))
(allow process-info*)

; The terminal. Without these an interactive shell cannot detect a TTY and
; coreutils refuses to run at all.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/null"))
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))

; Local IPC, plus the two Mach services a process cannot start without:
; opendirectoryd resolves the user's home directory, PowerManagement handles
; sleep. Everything else is withheld.
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-create)
(allow ipc-posix-shm-write-unlink)
(allow ipc-posix-sem)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control"))`;

/**
 * The Mach services needed only once the policy turns the network on: DNS
 * resolution, TLS trust evaluation, and the SystemConfiguration resolver.
 * Withheld under `network: "restricted"`, because a lookup service is a way out.
 */
const NETWORK_MACH_LOOKUP = `(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))`;

/** One `(param "KEY")` reference and the `-DKEY=value` argument that fills it. */
interface SeatbeltParam {
	key: string;
	value: string;
}

/**
 * Build the `sandbox-exec` argument vector for `policy`, wrapping `command`.
 *
 * Returns `command` **unchanged** for a policy that confines nothing and
 * permits the network: a wrapper whose profile grants everything is a
 * mechanism that can only be a no-op, and paying for `sandbox-exec` to reach
 * that result would be a wrapper that only looks like a sandbox. `argv[0]` of
 * the result is then the user's own program, which is the honest thing for a
 * caller to spawn and the thing a test can check.
 *
 * The exception is an unconfined filesystem with `network: "restricted"`, which
 * still wraps: dropping `--unshare-net` there would silently discard a
 * restriction the caller asked for, and a wrapper that under-delivers is worse
 * than the no-wrapper case above. That branch produces a profile allowing all
 * reads and writes and no network.
 *
 * **About `missingPathBehavior`:** this function cannot honour it. It is pure,
 * so it cannot tell whether `/w/.cache/labunbun` exists, and a `skip`-marked
 * entry that does not exist is passed through. Under seatbelt that is harmless
 * — a `subpath` filter matching nothing grants nothing. The caller must still
 * drop the non-existent ones before spawning.
 */
export function buildSeatbeltArgs(policy: SandboxPolicy, command: string[]): string[] {
	if (policy.fileSystem.kind === "unrestricted") {
		return policy.network === "enabled" ? [...command] : ["-p", unconfinedProfile(), "--", ...command];
	}

	const params: SeatbeltParam[] = [];
	const writableKeys: string[] = [];
	for (const [index, entry] of policy.fileSystem.entries.entries()) {
		if (!canWrite(entry.access)) continue;
		const key = `WRITABLE_ROOT_${index}`;
		params.push({ key, value: entry.path });
		writableKeys.push(key);
	}

	const deniedKeys: string[] = [];
	for (const [index, entry] of policy.fileSystem.entries.entries()) {
		if (entry.access !== "deny") continue;
		const key = `DENIED_${index}`;
		params.push({ key, value: entry.path });
		deniedKeys.push(key);
	}

	const protectedKeys: string[] = [];
	for (const [index, path] of policy.protected.entries()) {
		const key = `PROTECTED_${index}`;
		params.push({ key, value: path });
		protectedKeys.push(key);
	}

	const ancestorParams = protectedAncestors(policy);

	const sections: string[] = [
		BASE_POLICY,
		READ_BASELINE,
		...writableKeys.map((key) => `(allow file-write* (subpath (param "${key}")))`),
		networkPolicy(policy.network),
		...deniedKeys.map((key) => `(deny file-read* file-write* (subpath (param "${key}")))`),
		...protectedKeys.map((key) => `(deny file-write* (subpath (param "${key}")))`),
		...ancestorParams.map(
			(param) => `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "${param.key}"))))`,
		),
	];

	return [
		"-p",
		sections.filter((section) => section.length > 0).join("\n"),
		...params.map((param) => `-D${param.key}=${param.value}`),
		...ancestorParams.map((param) => `-D${param.key}=${param.value}`),
		"--",
		...command,
	];
}

/**
 * The read baseline: readable everywhere.
 *
 * This is why `read` entries produce no rule. `buildSandboxPolicy` records them
 * and says so on its own side — "on the backends where the default is readable
 * they are not emitted at all" — and this is one of those backends. The entries
 * are still carried for the Windows simulated layer, which has no readable
 * default and needs the list to answer at all.
 */
const READ_BASELINE = `; Read baseline: readable everywhere, matching Codex's read-only mode.
; "read" entries are additions to this and so emit no rule of their own.
(allow file-read*)`;

/** The network axis. Emitted last of the non-deny sections so the denies still close the profile. */
function networkPolicy(network: SandboxPolicy["network"]): string {
	if (network === "enabled") {
		return `; Network: enabled.
(allow network-outbound)
(allow network-inbound)
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))
${NETWORK_MACH_LOOKUP}`;
	}
	return `; Network: restricted. No network-outbound or network-inbound rule is present
; in this profile, and the base policy starts from (deny default), so the
; sandboxed process has no route off the machine.`;
}

/**
 * The profile for an unconfined filesystem under a restricted network: every
 * read and every write, no network. Reached only by the branch documented on
 * `buildSeatbeltArgs`; the fully-unconfined case returns the command instead.
 */
function unconfinedProfile(): string {
	return `${BASE_POLICY}
(allow file-read*)
(allow file-write*)
${networkPolicy("restricted")}`;
}

/**
 * Directory ancestors of every protected path and every denied path that sit
 * inside a writable root.
 *
 * Seatbelt matches on pathnames. Renaming a writable directory moves its
 * protected descendants with it — `mv /w/repo/sub /w/repo/x` turns a protected
 * `/w/repo/sub/.git` into `/w/repo/x/.git`, which no longer matches the deny
 * emitted for it, while `/w/repo/x` is writable through the broad root. Denying
 * `file-write-unlink` on those ancestors closes the rename, and it has to be
 * emitted after every allow for the same last-rule-wins reason as the denies
 * themselves. Codex does this for read-only subpaths
 * (`seatbelt.rs:912-935`, `seatbelt.rs:1064-1074`); it applies here to denied
 * paths too, because relocating a denied path onto an unnamed directory is the
 * same bypass.
 */
function protectedAncestors(policy: SandboxPolicy): SeatbeltParam[] {
	const writable = policy.fileSystem.entries.filter((entry) => canWrite(entry.access)).map((entry) => entry.path);
	const carved = [
		...policy.protected,
		...policy.fileSystem.entries.filter((entry) => entry.access === "deny").map((entry) => entry.path),
	];

	const ancestors = new Set<string>();
	for (const path of carved) {
		const root = writable.find((candidate) => isAtOrBelow(parentOf(path), candidate));
		if (root === undefined) continue;
		for (const ancestor of ancestorsUpTo(parentOf(path), root)) ancestors.add(ancestor);
	}

	// Sorted so the `-D` indices are a function of the policy rather than of
	// `Set` insertion order.
	return [...ancestors].sort().map((value, index) => ({ key: `PROTECTED_ANCESTOR_${index}`, value }));
}

/**
 * `path` and its parent directories, stopping once the walk leaves `root`.
 *
 * With `/w/repo` writable and `/w/repo/sub/.git` protected this yields
 * `["/w/repo/sub", "/w/repo"]` — the root itself included, because renaming the
 * writable root moves the protected directory just as effectively.
 */
function ancestorsUpTo(path: string, root: string): string[] {
	const chain: string[] = [];
	let current: string | undefined = path;
	while (current !== undefined && isAtOrBelow(current, root)) {
		chain.push(current);
		current = parentOf(current);
	}
	return chain;
}

/** The containing directory of an absolute path, or `undefined` at the root. */
function parentOf(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	if (index < 0) return trimmed;
	return index === 0 ? "/" : trimmed.slice(0, index);
}

/**
 * Whether `candidate` is `root` or sits inside it, on already-canonical absolute
 * paths with forward slashes — the form every producer in this build emits, and
 * the same comparison `isWritePermitted` makes on the other side of this seam.
 * Case is not folded: on a case-sensitive filesystem `Repo` and `repo` are
 * different directories.
 */
function isAtOrBelow(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
